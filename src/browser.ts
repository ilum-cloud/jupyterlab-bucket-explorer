import { PanelLayout, Widget } from '@lumino/widgets';

import { FileBrowser, DirListing } from '@jupyterlab/filebrowser';

import { S3Drive } from './contents';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { DocumentRegistry } from '@jupyterlab/docregistry';

import { Contents, ServerConnection } from '@jupyterlab/services';

import { URLExt } from '@jupyterlab/coreutils';

import {
  showErrorMessage,
  showDialog,
  Dialog,
  Toolbar
} from '@jupyterlab/apputils';

import { ToolbarButton } from '@jupyterlab/apputils';

import {
  fileUploadIcon,
  newFolderIcon,
  filterIcon,
  refreshIcon
} from '@jupyterlab/ui-components';

import { bucketIcon, databaseIcon } from './icons';

import { connectionService } from './connections';

import { VERSION } from './version';
import { MASKED_SECRET_VALUES, MASKED_SECRET_BULLETS } from './constants';

/**
 * Custom renderer for S3 DirListing to handle bucket icons
 */
export class S3DirListingRenderer extends DirListing.Renderer {
  updateItemNode(
    node: HTMLElement,
    model: Contents.IModel,
    fileType?: DocumentRegistry.IFileType,
    ...args: any[]
  ): void {
    if (model.mimetype === 'application/x-s3-bucket') {
      // Create a fake file type for the bucket
      const bucketFileType: DocumentRegistry.IFileType = {
        name: 's3-bucket',
        displayName: 'S3 Bucket',
        mimeTypes: ['application/x-s3-bucket'],
        extensions: [],
        contentType: 'directory',
        fileFormat: 'json',
        icon: bucketIcon
      };

      super.updateItemNode(node, model, bucketFileType, ...args);
      return;
    }

    // Handle .db files with custom database icon
    if (model.name.endsWith('.db')) {
      const databaseFileType: DocumentRegistry.IFileType = {
        name: 'database-file',
        displayName: 'Database File',
        mimeTypes: [],
        extensions: ['.db'],
        contentType: model.type === 'directory' ? 'directory' : 'file',
        fileFormat: 'base64',
        icon: databaseIcon
      };

      super.updateItemNode(node, model, databaseFileType, ...args);
      return;
    }

    super.updateItemNode(node, model, fileType, ...args);
  }
}

/**
 * Widget for authenticating against
 * an s3 object storage instance.
 */
let s3AuthenticationForm: any | undefined | null;

/**
 * Widget for hosting the S3 filebrowser.
 */
export class S3FileBrowser extends Widget {
  private _browser: FileBrowser;
  private _connectionSelect: HTMLSelectElement | null = null;
  private _explorerView: Widget | null = null;
  private _connectionStatuses: Map<string, boolean> = new Map();
  private _editingWidget: Widget | null = null;
  private _retryTimer: any = 0;
  private _isTesting = false;
  private _initialViewSet = false;
  private _defaultRegion: string = 'us-east-1';

  public set defaultRegion(region: string) {
    this._defaultRegion = region;
    this._updateFormDefaultRegion();
  }

  public get defaultRegion(): string {
    return this._defaultRegion;
  }

  private _updateFormDefaultRegion(): void {
    if (s3AuthenticationForm && s3AuthenticationForm.node) {
      const input = s3AuthenticationForm.node.querySelector(
        'input[name="region"]'
      ) as HTMLInputElement;
      if (input) {
        input.placeholder = this._defaultRegion;
        // If empty, pre-fill with default
        if (!input.value) {
          input.value = this._defaultRegion;
        }
      }
    }
  }

  constructor(browser: FileBrowser, drive: S3Drive, manager: IDocumentManager) {
    super();
    this._browser = browser;
    this.addClass('jp-S3Browser');
    this.layout = new PanelLayout();

    // Initialize connection service
    // connectionService.initialize().then(() => {
    //   this._updateConnectionSelector();
    // });
    // Initialization is now handled in index.ts with settings injection.
    // However, we still need to wait for it or just react to signals?
    // Since initialize is async, we might miss the initial update if we don't check.
    // But connectionsUpdated signal should fire.
    // Let's just rely on signals and safe check.
    if (connectionService.isInitialized) {
      this._updateConnectionSelector();
    }

    // Listen to connection changes
    connectionService.connectionChanged.connect(() => {
      browser.model.refresh();
      this._updateConnectionBadge();
    });

    connectionService.connectionsUpdated.connect(() => {
      this._updateConnectionSelector();
      this._updateConnectionBadge();

      // Set initial view on first update if not already set
      if (!this._initialViewSet && connectionService.hasConnections()) {
        this._initialViewSet = true;
        if (connectionService.activeConnectionId) {
          // Has active connection -> show browser view
          this._showBrowserView();
        } else {
          // No active connection but connections exist -> show explorer view
          this._showExplorerView();
        }
        return;
      }

      // If Explorer View is active, re-render it to show new connections
      if (this._explorerView && this._explorerView.parent) {
        this._renderExplorerViewWidget();
      }
      // Auto-test connections with retries (Debounced)
      if (this._retryTimer) {
        clearTimeout(this._retryTimer);
      }
      this._retryTimer = setTimeout(() => {
        void this._retryConnectionTests();
      }, 500);
    });

    // Listen to drive changes to force refresh
    drive.fileChanged.connect(() => {
      browser.model.refresh();
    });

    // Hack to remove incorrect tooltip from root breadcrumb
    const removeBreadcrumbTooltip = () => {
      const rootBreadcrumb = browser.node.querySelector(
        '.jp-BreadCrumbs-item[title="/home/jovyan"]'
      );
      if (rootBreadcrumb) {
        rootBreadcrumb.removeAttribute('title');
      }
      // Also general case for filebrowser root
      const homeBreadcrumb = browser.node.querySelector('.jp-BreadCrumbs-home');
      if (homeBreadcrumb) {
        homeBreadcrumb.removeAttribute('title');
        (homeBreadcrumb as HTMLElement).title = '';
      }
    };

    // Observer to handle dynamic breadcrumb updates
    const observer = new MutationObserver(() => {
      observer.disconnect();
      removeBreadcrumbTooltip();
      observer.observe(browser.node, {
        subtree: true,
        attributes: true,
        childList: true
      });
    });
    observer.observe(browser.node, {
      subtree: true,
      attributes: true,
      childList: true
    });
    // Initial call
    setTimeout(removeBreadcrumbTooltip, 500);

    // Inject styles for truncation and tooltip fix
    const style = document.createElement('style');
    style.textContent = `
      /* Force flex container behavior */
      .jp-BreadCrumbs {
        display: flex !important;
        flex-wrap: nowrap !important;
        overflow: hidden !important;
      }
      /* Allow items to shrink but normally expand to fill space */
      .jp-BreadCrumbs-item {
        flex: 0 1 auto !important; /* Default to auto sizing but allow shrink */
        min-width: 30px !important;
        max-width: none !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      /* The very last item (current folder) should take available space */
      .jp-BreadCrumbs-item:last-child {
        flex: 1 1 auto !important;
      }
      /* Prevent tooltip on root breadcrumb via CSS as backup */
      .jp-BreadCrumbs-item[title="/home/jovyan"] {
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);

    // filter button
    const filterButton = new ToolbarButton({
      icon: filterIcon,
      tooltip: 'Toggle Filter',
      onClick: () => {
        browser.showFileFilter = !browser.showFileFilter;
      }
    });

    // upload button
    const uploadButton = new ToolbarButton({
      icon: fileUploadIcon,
      tooltip: 'Upload Files',
      onClick: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = false;
        input.style.display = 'none';
        document.body.appendChild(input);

        input.onchange = async (e: Event) => {
          const target = e.target as HTMLInputElement;
          const files = target.files;
          if (!files || files.length === 0) {
            document.body.removeChild(input);
            return;
          }

          const file = files[0];
          const currentPath = browser.model.path;
          const driveName = drive.name;
          const localPath = currentPath.startsWith(`${driveName}:`)
            ? currentPath.slice(driveName.length + 1)
            : currentPath;

          const targetPath = localPath
            ? `${localPath}/${file.name}`
            : file.name;

          try {
            await drive.upload(targetPath, file);
            browser.model.refresh();
          } catch (error) {
            void showErrorMessage(
              'Upload Error',
              Error(`Failed to upload ${file.name}: ${error}`)
            );
          } finally {
            document.body.removeChild(input);
          }
        };
        input.click();
      }
    });

    // new folder button
    const newFolderButton = new ToolbarButton({
      icon: newFolderIcon,
      tooltip: 'New Folder',
      onClick: async () => {
        try {
          await manager.services.contents.newUntitled({
            path: browser.model.path,
            type: 'directory'
          });
          browser.model.refresh();
        } catch (error) {
          void showErrorMessage('New Folder Error', error as Error);
        }
      }
    });

    // separator widget
    const separator = new Widget();
    separator.addClass('jp-S3-toolbar-separator');

    // Clear default toolbar items and rebuild in new order
    // Layout: [Back] [Badge] --- spacer --- [Upload] [NewFolder] [Refresh] [Filter]

    // Exit Explorer button (back arrow) - position 0 (left group)
    const exitExplorerWidget = this._createExitExplorerButton();
    browser.toolbar.insertItem(0, 'exit-explorer', exitExplorerWidget);

    // Connection badge - position 1 (left group)
    const connectionWidget = this._createConnectionSelectorWidget();
    browser.toolbar.insertItem(1, 'connection-badge', connectionWidget);

    // Spacer at position 2 - pushes action icons to the right
    browser.toolbar.insertItem(2, 'center-spacer', Toolbar.createSpacerItem());

    // Action buttons on the right
    browser.toolbar.insertItem(10, 'filebrowser:upload', uploadButton);
    browser.toolbar.insertItem(11, 'filebrowser:new-folder', newFolderButton);

    // Refresh button
    const refreshButton = new ToolbarButton({
      icon: refreshIcon,
      tooltip: 'Refresh',
      onClick: () => {
        browser.model.refresh();
      }
    });
    browser.toolbar.insertItem(12, 'filebrowser:refresh', refreshButton);
    browser.toolbar.insertItem(13, 'filebrowser:filter', filterButton);

    /**
     * Function to handle setting credentials that are read
     * from the s3AuthenticationForm widget.
     */
    const s3AuthenticationFormSubmit = async (event: Event) => {
      event.preventDefault();
      const form = document.querySelector('#s3-form') as HTMLFormElement;
      const formData = new FormData(form);
      const data: any = {};
      (formData as any).forEach((value: string, key: string) => {
        data[key] = value;
      });

      // Map form data to connection object
      const connectionData = {
        name: data.name || 'S3 Connection',
        providerType: data.type ? data.type.toLowerCase() : 's3',
        url: data.url,
        accessKey: data.accessKey,
        secretKey: data.secretKey,
        region: data.region,
        isDefault: false
      };

      try {
        const result = await connectionService.addConnection(
          connectionData as any
        );
        if (result.success) {
          // Force backend auth update if it's the first one or requested?
          // For now, Settings-based persistence is primary.
          // We can optionally sync to backend if needed, but 'addConnection' is enough for UI.
          this._showExplorerView();
        } else {
          void showErrorMessage(
            'Connection Error',
            Error(result.message || 'Failed to add connection')
          );
        }
      } catch (error) {
        console.error('Failed to add connection:', error);
        void showErrorMessage('Connection Error', error as Error);
      }
    };

    /**
     * Check if we have active connections.
     * Render the browser if we do, otherwise show the empty state/auth form.
     */
    if (connectionService.hasConnections()) {
      (this.layout as PanelLayout).addWidget(browser);
      // Refresh to ensure content is up to date
      setTimeout(() => {
        browser.model.refresh();
      }, 500);
    } else {
      // Create empty state / auth form
      s3AuthenticationForm = new Widget({
        node: Private.createS3AuthenticationForm(
          s3AuthenticationFormSubmit,
          () => this._showExplorerView()
        )
      });
      s3AuthenticationForm.addClass('jp-Explorer-authWidget');
      (this.layout as PanelLayout).addWidget(s3AuthenticationForm);
      // Apply default region immediately
      this._updateFormDefaultRegion();
    }
  }

  /**
   * Create the connection selector widget for the toolbar.
   * New design: Shows a styled badge with icon and connection name
   */
  private _createConnectionSelectorWidget(): Widget {
    const container = document.createElement('div');
    container.className = 'jp-S3-connectionBadge';

    // Storage type icon (Box icon for S3)
    const iconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>';

    container.innerHTML = `
      <div class="jp-S3-connectionBadge-icon">${iconSvg}</div>
      <span class="jp-S3-connectionBadge-name">Loading...</span>
    `;

    // Store reference to update later
    this._connectionBadge = container;
    this._updateConnectionBadge();

    return new Widget({ node: container });
  }

  private _connectionBadge: HTMLElement | null = null;

  /**
   * Update the connection badge with current connection name.
   * This view is only accessible when there's an active connection,
   * so we always have a valid connection name to display.
   */
  private _updateConnectionBadge(): void {
    if (!this._connectionBadge) {
      return;
    }

    const nameEl = this._connectionBadge.querySelector(
      '.jp-S3-connectionBadge-name'
    );
    if (!nameEl) {
      return;
    }

    const activeConn = connectionService.activeConnection;
    nameEl.textContent =
      activeConn?.name || connectionService.connections[0]?.name || '';
  }

  /**
   * Update the connection selector dropdown with current connections.
   */
  private _updateConnectionSelector(): void {
    if (!this._connectionSelect) {
      return;
    }

    const select = this._connectionSelect;

    // Also update the badge if it exists
    this._updateConnectionBadge();

    if (!select) {
      return;
    }

    const currentValue = select.value;

    // Clear existing options
    select.innerHTML = '';

    const connections = connectionService.connections;

    if (connections.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No connections';
      select.appendChild(option);
    } else {
      connections.forEach(conn => {
        const option = document.createElement('option');
        option.value = conn.id;
        option.textContent = conn.name + (conn.isDefault ? ' ★' : '');
        select.appendChild(option);
      });
    }

    // Restore selection or set to active
    if (connectionService.activeConnectionId) {
      select.value = connectionService.activeConnectionId;
    } else if (currentValue) {
      select.value = currentValue;
    }
  }

  /**
   * Create the Exit Explorer button widget.
   * New design: Simple back arrow (chevron left) like reference UI
   */
  private _createExitExplorerButton(): Widget {
    const button = document.createElement('button');
    button.className = 'jp-S3-backBtn';
    button.title = 'Back to Explorer';

    // ChevronLeft icon
    const chevronLeftSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    button.innerHTML = chevronLeftSvg;

    button.addEventListener('click', () => {
      this._showExplorerView();
    });

    return new Widget({ node: button });
  }

  /**
   * Show form to add a new connection.
   */
  /*
  private _showAddConnectionForm(): void {
    // Show the existing S3 auth info form with back button to Explorer
    if (s3AuthenticationForm) {
      if (this._explorerView) {
        (this.layout as PanelLayout).removeWidget(this._explorerView);
      }
      (this.layout as PanelLayout).removeWidget(this._browser);
      (this.layout as PanelLayout).addWidget(s3AuthenticationForm);
    }
  }
  */

  /**
   * Show the Explorer view with connection list.
   */
  private async _showExplorerView(): Promise<void> {
    // Reset the create connection form if it exists
    this._resetCreateConnectionForm();

    // Remove current widgets
    (this.layout as PanelLayout).removeWidget(this._browser);
    if (s3AuthenticationForm) {
      (this.layout as PanelLayout).removeWidget(s3AuthenticationForm);
    }
    if (this._editingWidget) {
      (this.layout as PanelLayout).removeWidget(this._editingWidget);
      this._editingWidget = null;
    }

    // Refresh connections before showing explorer view
    await connectionService.refreshConnections();

    // Initial render
    this._renderExplorerViewWidget();

    // Trigger auto-test (background)
    void this._testAllConnections();
  }

  /**
   * Reset the create connection form to default state.
   */
  private _resetCreateConnectionForm(): void {
    if (!s3AuthenticationForm || !s3AuthenticationForm.node) {
      return;
    }

    const form = s3AuthenticationForm.node.querySelector(
      '#s3-form'
    ) as HTMLFormElement;
    if (form) {
      form.reset();

      // Reset storage type to S3
      const providerInput = form.querySelector(
        'input[name="providerType"]'
      ) as HTMLInputElement;
      if (providerInput) {
        providerInput.value = 's3';
      }

      // Reset UI state for type selector
      const container = s3AuthenticationForm.node;
      const typeButtons = container.querySelectorAll('.jp-Explorer-typeBtn');
      typeButtons.forEach((btn: Element) => btn.classList.remove('active'));

      // Find S3 button and make active
      const s3Btn = container.querySelector(
        '.jp-Explorer-typeBtn[data-type="S3"]'
      ) as HTMLElement;
      if (s3Btn) {
        s3Btn.classList.add('active');

        // Update highlight position manually or trigger a click?
        // Let's just reset the highlight style if possible, or leave it.
        // Re-using the updateHighlight logic if exposed would be better, but it's internal to createS3...
        // We can manually reset style if we know structure.
        const highlight = container.querySelector(
          '.jp-Explorer-typeHighlight'
        ) as HTMLElement;
        if (highlight) {
          highlight.style.left = '4px'; // 0 index
        }
      }
    }

    // Re-apply default region
    this._updateFormDefaultRegion();
  }

  private _renderExplorerViewWidget(): void {
    if (this._explorerView) {
      (this.layout as PanelLayout).removeWidget(this._explorerView);
    }

    // Create new Explorer view
    this._explorerView = new Widget({
      node: Private.createExplorerView(
        // onAddConnection
        () => {
          if (this._explorerView) {
            (this.layout as PanelLayout).removeWidget(this._explorerView);
          }
          if (s3AuthenticationForm) {
            (this.layout as PanelLayout).addWidget(s3AuthenticationForm);
            // Ensure default region is up to date when showing form
            this._updateFormDefaultRegion();
          }
        },
        // onConnectionClick - switch to browser
        (connectionId: string) => {
          connectionService.activeConnectionId = connectionId;
          this._showBrowserView();
        },
        // onEditConnection - show edit form
        (connectionId: string) => {
          this._showEditConnectionForm(connectionId);
        },
        // onDeleteConnection
        async (connectionId: string) => {
          const result = await showDialog({
            title: 'Delete Connection',
            body: 'Are you sure you want to delete this connection?',
            buttons: [
              Dialog.cancelButton(),
              Dialog.warnButton({ label: 'Delete' })
            ]
          });

          if (result.button.accept) {
            await connectionService.deleteConnection(connectionId);
            // Refresh Explorer view
            this._showExplorerView();
          }
        },
        // onRefresh
        async () => {
          const btn = this._explorerView?.node.querySelector(
            '.jp-Explorer-refreshBtn'
          );
          if (btn) {
            btn.classList.add('spinning');
          }
          await connectionService.refreshConnections();
          if (btn) {
            btn.classList.remove('spinning');
          }
        },
        this._connectionStatuses
      )
    });
    this._explorerView.addClass('jp-Explorer-authWidget');
    (this.layout as PanelLayout).addWidget(this._explorerView);
  }

  /**
   * Retries connection tests multiple times to ensure status is updated.
   * Useful when connections are just added or backend is warming up.
   */
  private async _retryConnectionTests(): Promise<void> {
    if (this._isTesting) {
      return;
    }
    this._isTesting = true;

    try {
      // Retry 3 times with 500ms delay
      const retries = 3;
      const delay = 500;

      for (let i = 0; i < retries; i++) {
        await this._testAllConnections();
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } finally {
      this._isTesting = false;
    }
  }

  private async _testAllConnections(): Promise<void> {
    const settings = ServerConnection.makeSettings();
    let changed = false;

    await Promise.all(
      connectionService.connections.map(async conn => {
        // [Opt] Skip if connection doesn't have required credentials or is just a placeholder
        if (
          !conn.accessKey ||
          !conn.secretKey ||
          MASKED_SECRET_VALUES.includes(conn.secretKey)
        ) {
          return;
        }

        try {
          const response = await ServerConnection.makeRequest(
            URLExt.join(
              settings.baseUrl,
              'jupyterlab-bucket-explorer/connections/test'
            ),
            {
              method: 'POST',
              body: JSON.stringify({
                connectionId: conn.id,
                url: conn.url,
                accessKey: conn.accessKey,
                secretKey: MASKED_SECRET_VALUES.includes(conn.secretKey)
                  ? ''
                  : conn.secretKey,
                region: conn.region
              })
            },

            settings
          );

          const data = await response.json();
          if (this._connectionStatuses.get(conn.id) !== data.success) {
            this._connectionStatuses.set(conn.id, data.success);
            changed = true;
          }
        } catch (e) {
          if (this._connectionStatuses.get(conn.id) !== false) {
            this._connectionStatuses.set(conn.id, false);
            changed = true;
          }
        }
      })
    );

    // [P2] Avoid re-showing Explorer after async tests
    // Only re-render if the explorer view is currently active (attached to the layout)
    if (changed && this._explorerView && this._explorerView.parent) {
      this._renderExplorerViewWidget();
    }
  }

  /**
   * Show the file browser view.
   */
  private _showBrowserView(): void {
    // Remove other widgets
    if (this._explorerView) {
      (this.layout as PanelLayout).removeWidget(this._explorerView);
      this._explorerView = null;
    }
    if (s3AuthenticationForm) {
      (this.layout as PanelLayout).removeWidget(s3AuthenticationForm);
    }
    if (this._editingWidget) {
      (this.layout as PanelLayout).removeWidget(this._editingWidget);
      this._editingWidget = null;
    }

    (this.layout as PanelLayout).addWidget(this._browser);
    // Reset to root to avoid stale view from previous connection
    this._browser.model.cd('/').then(() => {
      this._browser.model.refresh();
    });
  }

  /**
   * Show the edit connection form for a specific connection.
   */
  private _showEditConnectionForm(connectionId: string): void {
    const connection = connectionService.connections.find(
      c => c.id === connectionId
    );
    if (!connection) {
      return;
    }

    // Remove current widgets
    if (this._explorerView) {
      (this.layout as PanelLayout).removeWidget(this._explorerView);
    }
    (this.layout as PanelLayout).removeWidget(this._browser);

    // Create edit form
    const editFormNode = Private.createEditConnectionForm(
      connectionId,
      {
        name: connection.name,
        url: connection.url,
        accessKey: connection.accessKey,
        region: connection.region,
        secretKey: connection.secretKey
      },
      // onSubmit
      async (event: Event) => {
        event.preventDefault();
        const form = document.querySelector('#s3-edit-form') as HTMLFormElement;
        const formData = new FormData(form);
        const updates: any = {};

        (formData as any).forEach((value: string, key: string) => {
          // Filter out dummy masks
          if (value && !MASKED_SECRET_VALUES.includes(value)) {
            updates[key] = value;
          }
        });

        // Update connection
        const result = await connectionService.updateConnection(
          connectionId,
          updates
        );
        if (result.success) {
          await connectionService.refreshConnections();
          this._showExplorerView();
        } else {
          void showErrorMessage(
            'Update Error',
            Error(result.message || 'Failed to update connection')
          );
        }
      },
      // onBack
      () => {
        this._showExplorerView();
      }
    );

    this._editingWidget = new Widget({ node: editFormNode });
    this._editingWidget.addClass('jp-Explorer-authWidget');
    (this.layout as PanelLayout).addWidget(this._editingWidget);
  }
}

namespace Private {
  /**
   * Creates the new connection form widget with underline inputs
   * @param onSubmit A function to be called when the submit button is clicked.
   * @param onBack A function to be called when the back button is clicked.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  export function createS3AuthenticationForm(
    onSubmit: any,
    onBack?: any
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'jp-Explorer-formContainer';

    // ArrowLeft SVG icon
    const arrowLeftSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>';

    // Storage type icons
    const boxIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>';
    const cloudIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>';
    const databaseIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>';
    const hardDriveIcon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>';

    container.innerHTML = `
      <!-- Header -->
      <div class="jp-Explorer-formHeader">
        <h1 class="jp-Explorer-formTitle">New Connection</h1>
        <button class="jp-Explorer-backBtn" type="button" title="Back to Explorer">${arrowLeftSvg}</button>
      </div>
      
      <!-- Form Content -->
      <form id="s3-form" method="post" class="jp-Explorer-formContent">
        <!-- Storage Type Selector -->
        <div class="jp-Explorer-typeSelector">
          <label class="jp-Explorer-fieldLabel">Storage Type</label>
          <div class="jp-Explorer-typeSelectorContainer">
            <div class="jp-Explorer-typeHighlight"></div>
            <button type="button" data-type="S3" class="jp-Explorer-typeBtn active">
              ${boxIcon}
              <span>S3</span>
            </button>
            <button type="button" data-type="GCS" class="jp-Explorer-typeBtn">
              ${cloudIcon}
              <span>GCS</span>
            </button>
            <button type="button" data-type="WASBS" class="jp-Explorer-typeBtn">
              ${databaseIcon}
              <span>WASBS</span>
            </button>
            <button type="button" data-type="HDFS" class="jp-Explorer-typeBtn">
              ${hardDriveIcon}
              <span>HDFS</span>
            </button>
          </div>
        </div>
        <input type="hidden" name="providerType" value="s3" />
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Name</label>
          <input type="text" name="name" class="jp-Explorer-fieldInput" placeholder="e.g. Production S3" autocomplete="off" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Endpoint URL</label>
          <input type="url" name="url" class="jp-Explorer-fieldInput" autocomplete="off" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Access Key</label>
          <input type="text" name="accessKey" class="jp-Explorer-fieldInput" autocomplete="new-password" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Secret Key</label>
          <input type="password" name="secretKey" class="jp-Explorer-fieldInput" autocomplete="new-password" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Region</label>
          <input type="text" name="region" class="jp-Explorer-fieldInput" placeholder="us-east-1" autocomplete="off" />
        </div>
        
        <div class="jp-Explorer-testContainer">
          <button class="jp-Explorer-testBtn" type="button">Test Connection</button>
        </div>
        
        <button class="jp-Explorer-submitBtn" type="button">Create Connection</button>
        
        <div class="jp-Explorer-formHints">
          <div class="jp-Explorer-hint">
            <div class="jp-Explorer-hintDot"></div>
            <p class="jp-Explorer-hintText">MinIO: Region not required</p>
          </div>
        </div>
      </form>
    `;

    // Add event listeners
    const submitBtn = container.querySelector('.jp-Explorer-submitBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', onSubmit);
    }

    const backBtn = container.querySelector('.jp-Explorer-backBtn');
    if (backBtn && onBack) {
      backBtn.addEventListener('click', onBack);
    }

    // Storage Type Selector Logic
    const typeButtons = container.querySelectorAll('.jp-Explorer-typeBtn');
    const highlight = container.querySelector(
      '.jp-Explorer-typeHighlight'
    ) as HTMLElement;
    const providerInput = container.querySelector(
      'input[name="providerType"]'
    ) as HTMLInputElement;

    const updateHighlight = (activeBtn: HTMLElement) => {
      const containerEl = container.querySelector(
        '.jp-Explorer-typeSelectorContainer'
      ) as HTMLElement;
      if (!containerEl || !highlight) {
        return;
      }

      const index = Array.from(typeButtons).indexOf(activeBtn);
      const width = 100 / typeButtons.length;
      highlight.style.left = `calc(${index * width}% + 4px)`;
      highlight.style.width = `calc(${width}% - 8px)`;
    };

    typeButtons.forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const type = (btn as HTMLElement).dataset.type?.toLowerCase() || 's3';

        // Block non-S3 types with message
        if (type !== 's3') {
          void showErrorMessage(
            'Storage Type Not Supported',
            `${type.toUpperCase()} storage is not yet supported. Only S3-compatible storage is currently available.`
          );
          return;
        }

        // Remove active from all
        typeButtons.forEach(b => b.classList.remove('active'));
        // Add active to clicked
        btn.classList.add('active');
        // Update hidden input
        if (providerInput) {
          providerInput.value = type;
        }
        // Update highlight position
        updateHighlight(btn as HTMLElement);
      });
    });

    // Initialize highlight position
    setTimeout(() => {
      const activeBtn = container.querySelector(
        '.jp-Explorer-typeBtn.active'
      ) as HTMLElement;
      if (activeBtn) {
        updateHighlight(activeBtn);
      }
    }, 0);

    // Test Connection Logic - button changes itself for 5 seconds
    const testBtn = container.querySelector(
      '.jp-Explorer-testBtn'
    ) as HTMLButtonElement;

    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const form = container.querySelector('#s3-form') as HTMLFormElement;
        const formData = new FormData(form);

        const url = (formData.get('url') as string)?.trim() || '';
        const accessKey = (formData.get('accessKey') as string)?.trim() || '';
        const secretKey = (formData.get('secretKey') as string)?.trim() || '';
        const region = (formData.get('region') as string)?.trim() || '';

        // Store original button state
        const originalText = testBtn.textContent;
        const originalClass = testBtn.className;

        // Show loading state on button
        testBtn.textContent = 'Testing...';
        testBtn.className = 'jp-Explorer-testBtn testing';
        testBtn.disabled = true;

        try {
          const settings = ServerConnection.makeSettings();
          const response = await ServerConnection.makeRequest(
            URLExt.join(
              settings.baseUrl,
              'jupyterlab-bucket-explorer/connections/test'
            ),
            {
              method: 'POST',
              body: JSON.stringify({ url, accessKey, secretKey, region })
            },
            settings
          );

          const data = await response.json();

          if (data.success) {
            testBtn.textContent = '✓ Success';
            testBtn.className = 'jp-Explorer-testBtn success';
          } else {
            const errorMsg = data.message || 'Connection failed';
            testBtn.textContent = `✗ ${errorMsg}`;
            testBtn.className = 'jp-Explorer-testBtn error';
          }
        } catch (error: any) {
          const errorMsg = error.message || 'Connection error';
          testBtn.textContent = `✗ ${errorMsg}`;
          testBtn.className = 'jp-Explorer-testBtn error';
        }

        // Reset button after 3 seconds
        setTimeout(() => {
          testBtn.textContent = originalText;
          testBtn.className = originalClass;
          testBtn.disabled = false;
        }, 3000);
      });
    }

    return container;
  }

  /**
   * Creates the edit connection form widget.
   * Similar to add form but with different title, no hints, and Save Changes button.
   * @param connection The connection data to pre-fill
   * @param onSubmit A function to be called when the submit button is clicked.
   * @param onBack A function to be called when the back button is clicked.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  export function createEditConnectionForm(
    connectionId: string,
    connection: {
      name?: string;
      url?: string;
      accessKey?: string;
      region?: string;
      secretKey?: string;
    },
    onSubmit: any,
    onBack?: any
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'jp-Explorer-formContainer';

    // ArrowLeft SVG icon
    const arrowLeftSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>';

    container.innerHTML = `
      <!-- Header -->
      <div class="jp-Explorer-formHeader">
        <h1 class="jp-Explorer-formTitle">Edit Connection</h1>
        ${onBack ? `<button class="jp-Explorer-backBtn" type="button" title="Back to Explorer">${arrowLeftSvg}</button>` : ''}
      </div>
      
      <!-- Form Content -->
      <form id="s3-edit-form" method="post" class="jp-Explorer-formContent">
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Name</label>
          <input type="text" name="name" class="jp-Explorer-fieldInput" placeholder="e.g. Production S3" value="${connection.name || ''}" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Endpoint URL</label>
          <input type="url" name="url" class="jp-Explorer-fieldInput" value="${connection.url || ''}" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Access Key</label>
          <input type="text" name="accessKey" class="jp-Explorer-fieldInput" value="${connection.accessKey || ''}" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Secret Key</label>
          <input type="password" name="secretKey" class="jp-Explorer-fieldInput" placeholder="Leave empty to keep current" value="${
            !connection.secretKey ||
            MASKED_SECRET_VALUES.includes(connection.secretKey)
              ? MASKED_SECRET_BULLETS
              : connection.secretKey
          }" />
        </div>
        
        <div class="jp-Explorer-field">
          <label class="jp-Explorer-fieldLabel">Region</label>
          <input type="text" name="region" class="jp-Explorer-fieldInput" placeholder="us-east-1" value="${connection.region || ''}" />
        </div>
        
        <div class="jp-Explorer-testContainer">
          <button class="jp-Explorer-testBtn" type="button">Test Connection</button>
        </div>

        <button class="jp-Explorer-submitBtn" type="button">Save Changes</button>
      </form>
    `;

    // Add event listeners
    const submitBtn = container.querySelector('.jp-Explorer-submitBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', onSubmit);
    }

    const backBtn = container.querySelector('.jp-Explorer-backBtn');
    if (backBtn && onBack) {
      backBtn.addEventListener('click', onBack);
    }

    // Test Connection Logic - button changes itself for 5 seconds
    const testBtn = container.querySelector(
      '.jp-Explorer-testBtn'
    ) as HTMLButtonElement;

    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const form = container.querySelector(
          '#s3-edit-form'
        ) as HTMLFormElement;
        const formData = new FormData(form);

        const url = (formData.get('url') as string)?.trim() || '';
        const accessKey = (formData.get('accessKey') as string)?.trim() || '';
        let secretKey = (formData.get('secretKey') as string)?.trim() || '';

        // If secretKey is empty, check if we have a valid (non-masked) one in connection
        // But usually connection.secretKey IS masked, so this fallback is rarely useful for fetching real secrets
        if (
          !secretKey &&
          connection.secretKey &&
          !MASKED_SECRET_VALUES.includes(connection.secretKey)
        ) {
          secretKey = connection.secretKey;
        }

        // Final check: If the resulting key is ANY mask, send empty string
        // This triggers the backend to look up the stored secret via connectionId
        if (MASKED_SECRET_VALUES.includes(secretKey)) {
          secretKey = '';
        }

        const region = (formData.get('region') as string)?.trim() || '';

        // Store original button state
        const originalText = testBtn.textContent;
        const originalClass = testBtn.className;

        // Show loading state on button
        testBtn.textContent = 'Testing...';
        testBtn.className = 'jp-Explorer-testBtn testing';
        testBtn.disabled = true;

        try {
          const settings = ServerConnection.makeSettings();
          const response = await ServerConnection.makeRequest(
            URLExt.join(
              settings.baseUrl,
              'jupyterlab-bucket-explorer/connections/test'
            ),
            {
              method: 'POST',
              body: JSON.stringify({
                url,
                accessKey,
                secretKey,
                region,
                connectionId
              })
            },
            settings
          );

          const data = await response.json();

          if (data.success) {
            testBtn.textContent = '✓ Success';
            testBtn.className = 'jp-Explorer-testBtn success';
          } else {
            testBtn.textContent = '✗ Failed';
            testBtn.className = 'jp-Explorer-testBtn error';
          }
        } catch (error: any) {
          testBtn.textContent = '✗ Error';
          testBtn.className = 'jp-Explorer-testBtn error';
        }

        // Reset button after 3 seconds
        setTimeout(() => {
          testBtn.textContent = originalText;
          testBtn.className = originalClass;
          testBtn.disabled = false;
        }, 3000);
      });
    }

    return container;
  }

  /**
   * Creates the Explorer view showing all connections grouped by provider type.
   * @param onAddConnection Callback when "Add Connection" is clicked
   * @param onConnectionClick Callback when a connection is clicked (to browse)
   * @param onDeleteConnection Callback when delete is clicked
   */
  export function createExplorerView(
    onAddConnection: () => void,
    onConnectionClick: (connectionId: string) => void,
    onEditConnection: (connectionId: string) => void,
    onDeleteConnection: (connectionId: string) => void,
    onRefresh: () => void,
    connectionStatuses: Map<string, boolean>
  ): HTMLElement {
    const connections = connectionService.connections;

    // Refresh Icon SVG
    const refreshIconSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

    // Group connections by type
    const s3Connections = connections.filter(
      c => c.providerType === 's3' || !c.providerType
    );
    const gcsConnections = connections.filter(c => c.providerType === 'gcs');

    // S3 Icon SVG
    const s3IconSvg =
      '<svg width="26" height="26" style="width: 26px; height: 26px;" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path fill="#e05243" d="M260 348l-137 33V131l137 32z"/><path fill="#8c3123" d="M256 349l133 32V131l-133 32v186"/><g fill="#e05243"><path id="a" d="M256 64v97l58 14V93zm133 67v250l26-13V143zm-133 77v97l58-8v-82zm58 129l-58 14v97l58-29z"/></g><use fill="#8c3123" transform="rotate(180 256 256)" xlink:href="#a"/><path fill="#5e1f18" d="M314 175l-58 11-58-11 58-15 58 15"/><path fill="#f2b0a9" d="M314 337l-58-11-58 11 58 16 58-16"/></svg>';

    // GCS Icon SVG
    const gcsIconSvg =
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2Z" fill="#4285F4"/></svg>';

    // Create container
    const container = document.createElement('div');
    container.className = 'jp-Explorer-container';

    // Header
    const header = document.createElement('div');
    header.className = 'jp-Explorer-header';
    header.innerHTML = `
      <h1 class="jp-Explorer-title">Explorer</h1>
      <button class="jp-Explorer-refreshBtn" title="Refresh Connections">
        ${refreshIconSvg}
      </button>
      <button class="jp-Explorer-addBtn" title="Add new connection">
        <span style="font-size: 16px; font-weight: bold;">+</span>
        <span>ADD</span>
      </button>
    `;
    header
      .querySelector('.jp-Explorer-refreshBtn')
      ?.addEventListener('click', onRefresh);
    header
      .querySelector('.jp-Explorer-addBtn')
      ?.addEventListener('click', onAddConnection);
    container.appendChild(header);

    // Connection list
    const list = document.createElement('div');
    list.className = 'jp-Explorer-list';

    // Helper to create category section
    const createCategory = (
      label: string,
      iconSvg: string,
      conns: typeof connections,
      collapsed: boolean = false
    ) => {
      if (conns.length === 0) {
        return null;
      }

      const section = document.createElement('div');
      section.className = 'jp-Explorer-category';

      // Category header
      const catHeader = document.createElement('div');
      catHeader.className =
        'jp-Explorer-categoryHeader' + (collapsed ? ' collapsed' : '');
      catHeader.innerHTML = `
        <div class="jp-Explorer-categoryInfo">
          <div class="jp-Explorer-categoryIcon">${iconSvg}</div>
          <span class="jp-Explorer-categoryLabel">${label}</span>
        </div>
        <div class="jp-Explorer-categoryMeta">
          <span class="jp-Explorer-categoryCount">${conns.length}</span>
          <span class="jp-Explorer-categoryChevron">▼</span>
        </div>
      `;

      // Items container
      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'jp-Explorer-categoryItems';
      itemsContainer.style.display = collapsed ? 'none' : 'block';

      // Toggle collapse
      catHeader.addEventListener('click', () => {
        catHeader.classList.toggle('collapsed');
        itemsContainer.style.display = catHeader.classList.contains('collapsed')
          ? 'none'
          : 'block';
      });

      // Add connection items
      conns.forEach(conn => {
        const item = document.createElement('div');
        item.className = 'jp-Explorer-connectionItem';
        item.innerHTML = `
          <div class="jp-Explorer-connectionInfo">
            <div class="jp-Explorer-statusDot ${connectionStatuses.get(conn.id) === true ? 'success' : connectionStatuses.get(conn.id) === false ? 'error' : 'neutral'}"></div>
            <span class="jp-Explorer-connectionName">${conn.name}</span>
          </div>
          <div class="jp-Explorer-connectionActions">
            <button class="jp-Explorer-actionBtn edit" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
            <button class="jp-Explorer-actionBtn delete" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
        `;

        // Click to browse
        item.addEventListener('click', e => {
          if (!(e.target as HTMLElement).closest('.jp-Explorer-actionBtn')) {
            onConnectionClick(conn.id);
          }
        });

        // Delete button
        item
          .querySelector('.jp-Explorer-actionBtn.delete')
          ?.addEventListener('click', e => {
            e.stopPropagation();
            onDeleteConnection(conn.id);
          });

        // Edit button
        item
          .querySelector('.jp-Explorer-actionBtn.edit')
          ?.addEventListener('click', e => {
            e.stopPropagation();
            onEditConnection(conn.id);
          });

        itemsContainer.appendChild(item);
      });

      section.appendChild(catHeader);
      section.appendChild(itemsContainer);
      return section;
    };

    // Add S3 category
    const s3Category = createCategory(
      'AWS S3 Storage',
      s3IconSvg,
      s3Connections
    );
    if (s3Category) {
      list.appendChild(s3Category);
    }

    // Add GCS category
    const gcsCategory = createCategory(
      'Google Cloud Storage',
      gcsIconSvg,
      gcsConnections
    );
    if (gcsCategory) {
      list.appendChild(gcsCategory);
    }

    // Empty state
    if (connections.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'jp-Explorer-empty';
      empty.innerHTML =
        '<p class="jp-Explorer-emptyText">No connections active</p>';
      list.appendChild(empty);
    }

    container.appendChild(list);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'jp-Explorer-footer';
    footer.innerHTML = `
      <p class="jp-Explorer-footerText">by <a href="https://ilum.cloud/" target="_blank" class="jp-Explorer-footerLink">ilum.cloud</a></p>
      <p class="jp-Explorer-footerText"><a href="https://github.com/ilum-cloud/jupyterlab-bucket-explorer" target="_blank" class="jp-Explorer-footerLink">v${VERSION}</a></p>
    `;
    container.appendChild(footer);

    return container;
  }
}
