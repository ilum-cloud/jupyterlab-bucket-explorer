import { expect, test } from '@jupyterlab/galata';

// Override Galata's default waitForApplication hook which waits indefinitely
// for the Launcher tab to become active (no timeout). On JupyterLab 4.5 the
// Launcher is not always activated automatically, so the built-in wait can
// stall the whole suite. We replace it with a bounded check that only waits
// for the splash screen to disappear and the main dock panel to render.
test.use({
  autoGoto: false,
  waitForApplication: async ({}, use) => {
    const waitIsReady = async (page: any, _testHelpers?: any) => {
      await page.waitForSelector('#jupyterlab-splash', {
        state: 'detached',
        timeout: 60_000
      });
      await page.waitForSelector('#jp-main-dock-panel', {
        state: 'visible',
        timeout: 60_000
      });
    };
    await use(waitIsReady);
  }
});

/**
 * Helper to set up route mocks before Galata navigates
 */
async function setupMocks(
  page: any,
  options: {
    mockAuthenticated?: boolean;
    mockFiles?: boolean;
    mockAuth?: boolean;
  } = {}
) {
  // Determine authentication state: mockAuth takes precedence, fallback to mockAuthenticated
  let shouldBeAuthenticated: boolean | undefined;
  if (typeof options.mockAuth === 'boolean') {
    shouldBeAuthenticated = options.mockAuth;
  } else if (typeof options.mockAuthenticated === 'boolean') {
    shouldBeAuthenticated = options.mockAuthenticated;
  }

  if (shouldBeAuthenticated !== undefined) {
    await page.route('**/jupyterlab-bucket-explorer/auth**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: shouldBeAuthenticated })
        });
        return;
      }
      await route.continue();
    });
  }

  // Handle mockFiles if we are authenticated (legacy behavior linked to mockAuthenticated)
  if (options.mockAuthenticated && options.mockFiles !== false) {
    await page.route('**/jupyterlab-bucket-explorer/files**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([])
        });
        return;
      }
      await route.continue();
    });
  }
}

async function openLab(page: any) {
  await page.goto('');
}

async function openBucketExplorer(page: any) {
  const s3Tab = page.getByRole('tab', { name: 'Bucket Explorer' });
  const s3TabId = await s3Tab.getAttribute('data-id');

  if (s3TabId) {
    await page.sidebar.openTab(s3TabId);
  } else {
    await s3Tab.click();
  }

  await page.locator('.jp-S3Browser').waitFor({ state: 'visible' });
}

async function openAuthForm(page: any) {
  await openBucketExplorer(page);

  const formContainer = page.locator('.jp-Explorer-formContainer');
  if (await formContainer.isVisible()) {
    return;
  }

  const backButton = page.locator('.jp-S3-backBtn');
  if (await backButton.isVisible()) {
    await backButton.click();
  }

  const addButton = page.locator('.jp-Explorer-addBtn');
  if (await addButton.isVisible()) {
    await addButton.click();
  }

  await expect(formContainer).toBeVisible({ timeout: 10000 });
}

async function createConnectionFromEnv(page: any) {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  const region = process.env.S3_REGION;

  if (!endpoint || !accessKey || !secretKey) {
    throw new Error(
      'Missing S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY env vars for E2E setup.'
    );
  }

  const formContainer = page.locator('.jp-Explorer-formContainer');
  if (!(await formContainer.isVisible())) {
    const addButton = page.locator('.jp-Explorer-addBtn');
    if (await addButton.isVisible()) {
      await addButton.click();
    }
  }

  await expect(formContainer).toBeVisible({ timeout: 10000 });
  await page.locator('input[name="name"]').fill('E2E MinIO');
  await page.locator('input[name="url"]').fill(endpoint);
  await page.locator('input[name="accessKey"]').fill(accessKey);
  await page.locator('input[name="secretKey"]').fill(secretKey);
  if (region) {
    await page.locator('input[name="region"]').fill(region);
  }

  await page.locator('.jp-Explorer-submitBtn').click();
}

async function openBucketBrowser(
  page: any,
  options: { allowCreateFromEnv?: boolean } = {}
) {
  await openBucketExplorer(page);

  const explorerView = page.locator('.jp-Explorer-container');
  try {
    await explorerView.waitFor({ state: 'visible', timeout: 2000 });
    const connectionItems = page.locator('.jp-Explorer-connectionItem');
    if ((await connectionItems.count()) > 0) {
      await connectionItems.first().click();
    } else if (options.allowCreateFromEnv) {
      await createConnectionFromEnv(page);
      const createdConnection = page
        .locator('.jp-Explorer-connectionItem')
        .first();
      await expect(createdConnection).toBeVisible({ timeout: 20000 });
      await createdConnection.click();
    }
  } catch {
    // Explorer view not visible; assume we are already in browser view.
  }

  await page
    .locator('.jp-S3Browser .jp-FileBrowser')
    .first()
    .waitFor({ state: 'visible' });
}

async function setupConnectionMocks(page: any) {
  const connections = [
    {
      id: 'test-conn',
      name: 'Test Connection',
      providerType: 's3',
      url: 'http://localhost:9000',
      accessKey: 'test',
      secretKey: 'test',
      region: 'us-east-1',
      isDefault: true
    }
  ];

  await page.route('**/jupyterlab-bucket-explorer/connections**', async route => {
    const req = route.request();

    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connections,
          count: connections.length
        })
      });
      return;
    }

    if (req.method() === 'POST' && req.url().includes('/test')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
      return;
    }

    await route.continue();
  });
}

async function setupEmptyConnectionMocks(page: any) {
  await page.route('**/jupyterlab-bucket-explorer/connections**', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connections: [], count: 0 })
      });
      return;
    }
    await route.continue();
  });
}

test.describe('Bucket Explorer', () => {
  test('s3 browser loads and sidebar icon is visible', async ({ page }) => {
    // Mock as unauthenticated to avoid hitting real S3
    await setupMocks(page, { mockAuth: false });
    await openLab(page);

    const s3Tab = page.getByRole('tab', { name: 'Bucket Explorer' });
    await expect(s3Tab).toBeVisible();

    const s3TabId = await s3Tab.getAttribute('data-id');
    expect(s3TabId).toBeTruthy();

    const position = await page.sidebar.getTabPosition(s3TabId as string);
    expect(position).toBe('left');
  });

  test('shows authentication form when unauthenticated', async ({ page }) => {
    await setupEmptyConnectionMocks(page);
    await setupMocks(page, { mockAuth: false });
    await openLab(page);

    await openAuthForm(page);

    // The form should be visible with all input fields
    await expect(page.locator('input[name="url"]')).toBeVisible({
      timeout: 10000
    });
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="accessKey"]')).toBeVisible();
    await expect(page.locator('input[name="secretKey"]')).toBeVisible();
  });

  test('shows filter input and back button navigates to Explorer when authenticated', async ({
    page
  }) => {
    await setupConnectionMocks(page);
    await setupMocks(page, { mockAuthenticated: true });
    await openLab(page);

    await openBucketBrowser(page);

    const filterButton = page
      .locator('.jp-S3Browser')
      .locator(
        'button[title="Toggle Filter"], button[aria-label="Toggle Filter"]'
      );
    await expect(filterButton).toBeVisible();
    await filterButton.click();

    const filterInput = page
      .locator('.jp-S3Browser')
      .locator(
        '.jp-FileBrowser-filterInput, .jp-FileBrowser-filterBox input'
      )
      .first();
    await expect(filterInput).toBeVisible();

    // New UI has Back to Explorer button
    const backButton = page.locator('.jp-S3Browser .jp-S3-backBtn');
    await expect(backButton).toBeVisible();
    await backButton.click();

    // Clicking Back should show Explorer view
    await expect(page.locator('.jp-Explorer-container')).toBeVisible({
      timeout: 10000
    });
  });

  test('upload button sends file payload', async ({ page }) => {
    let uploadRequested = false;

    await page.route('**/jupyterlab-bucket-explorer/upload/**', async route => {
      uploadRequested = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          path: 'test.txt',
          type: 'file',
          name: 'test.txt'
        })
      });
    });

    await setupConnectionMocks(page);
    await setupMocks(page, { mockAuthenticated: true });
    await openLab(page);

    await openBucketBrowser(page);

    const uploadButton = page
      .locator('.jp-S3Browser')
      .locator(
        'button[title="Upload Files"], button[aria-label="Upload Files"]'
      )
      .first();
    await expect(uploadButton).toBeVisible();

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      uploadButton.click()
    ]);
    await fileChooser.setFiles({
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello')
    });

    await expect.poll(() => uploadRequested).toBe(true);
  });

  test('shows auth error dialog on invalid credentials', async ({ page }) => {
    // Mock connections endpoint to return empty list
    await page.route(
      '**/jupyterlab-bucket-explorer/connections**',
      async route => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ connections: [], count: 0 })
          });
          return;
        }
        // For test_credentials POST
        if (route.request().method() === 'POST') {
          const url = route.request().url();
          if (url.includes('/test')) {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ success: false })
            });
            return;
          }
        }
        await route.continue();
      }
    );

    await setupMocks(page, { mockAuth: false });
    await openLab(page);

    const s3Tab = page.getByRole('tab', { name: 'Bucket Explorer' });
    await s3Tab.click();

    // When unauthenticated, the auth form is shown directly
    const formContainer = page.locator('.jp-Explorer-formContainer');
    await formContainer.waitFor({ state: 'visible', timeout: 10000 });

    // Form should already be visible, fill in credentials
    await page.locator('input[name="name"]').fill('test-connection');
    await page.locator('input[name="url"]').fill('http://localhost:9000');
    await page.locator('input[name="accessKey"]').fill('bad');
    await page.locator('input[name="secretKey"]').fill('bad');

    // Click Test Connection button
    await page.locator('.jp-Explorer-testBtn').click();

    // Button should show error state (not a dialog)
    const testBtn = page.locator('.jp-Explorer-testBtn');
    await expect(testBtn).toHaveClass(/error/, { timeout: 10000 });
  });

  test('delete prompts for confirmation and sends delete request', async ({
    page
  }) => {
    const deleteRequests: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];

    await page.route('**/jupyterlab-bucket-explorer/files**', async route => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              name: 'folder',
              path: 'bucket/folder',
              type: 'directory',
              mimetype: ''
            }
          ])
        });
        return;
      }
      if (req.method() === 'DELETE') {
        const headers = req.headers();
        deleteRequests.push({ url: req.url(), headers });
        if (
          headers['x-storage-recursive'] === 'true' ||
          req.url().includes('recursive=true')
        ) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({})
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'DIR_NOT_EMPTY',
              message: 'DIR_NOT_EMPTY'
            })
          });
        }
        return;
      }
      await route.continue();
    });

    await setupConnectionMocks(page);
    await setupMocks(page, { mockAuthenticated: true, mockFiles: false });
    await openLab(page);

    await openBucketBrowser(page);

    const targetRow = page
      .locator('.jp-S3Browser .jp-DirListing-item', { hasText: 'folder' })
      .first();
    await targetRow.click();

    await targetRow.click({ button: 'right' });
    const deleteMenuItem = page.getByRole('menuitem', { name: 'Delete' });
    await expect(deleteMenuItem).toBeVisible();
    await deleteMenuItem.click();

    const dialog = page.locator('.jp-Dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect.poll(() => deleteRequests.length).toBeGreaterThan(0);
  });

  test('minio e2e lists bucket and file', async ({ page }, testInfo) => {
    testInfo.setTimeout(180000); // 3 min for e2e test with real MinIO
    test.skip(!process.env.E2E_MINIO, 'E2E_MINIO not set');

    await openLab(page);

    await openBucketBrowser(page, { allowCreateFromEnv: true });

    // Verify successful authentication (no error dialog)
    await expect(page.locator('.jp-Dialog')).toBeHidden();

    const bucketRow = page
      .locator('.jp-S3Browser .jp-DirListing-item', { hasText: 'ci-bucket' })
      .first();
    await expect(bucketRow).toBeVisible({ timeout: 15000 });
    await bucketRow.dblclick();

    const fileRow = page
      .locator('.jp-S3Browser .jp-DirListing-item', { hasText: 'hello.txt' })
      .first();
    await expect(fileRow).toBeVisible({ timeout: 15000 });
  });
});
