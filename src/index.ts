import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { Clipboard } from '@jupyterlab/apputils';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { IDocumentManager } from '@jupyterlab/docmanager';

import {
  IFileBrowserFactory,
  FilterFileBrowserModel,
  FileBrowser
} from '@jupyterlab/filebrowser';

import { Contents } from '@jupyterlab/services';

import { S3Drive } from './contents';

import { S3FileBrowser, S3DirListingRenderer } from './browser';

import { s3Icon, bucketIcon } from './icons';

import { connectionService } from './connections';

/**
 * S3 filebrowser plugin state namespace.
 */
const NAMESPACE = 's3-filebrowser';

/**
 * The ID for the plugin.
 */
const PLUGIN_ID = 'jupyterlab-bucket-explorer:plugin';

/**
 * Initialization data for the jupyterlab-bucket-explorer extension.
 */
const fileBrowserPlugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  autoStart: true,
  optional: [
    IDocumentManager,
    IFileBrowserFactory,
    ILayoutRestorer,
    ISettingRegistry
  ],
  activate: activateFileBrowser
};
/**
 * Activate the file browser.
 */
function activateFileBrowser(
  app: JupyterFrontEnd,
  manager: IDocumentManager,
  factory: IFileBrowserFactory,
  restorer: ILayoutRestorer,
  settingRegistry: ISettingRegistry
  // translator: ITranslator,
  // commandPalette: ICommandPalette | null
): void {
  // Add the S3 backend to the contents manager.
  const drive = new S3Drive(app.docRegistry);
  manager.services.contents.addDrive(drive);

  // Register bucket file type (icon availability).
  // Custom renderer handles assignment to buckets via mimetype.
  app.docRegistry.addFileType({
    name: 's3-bucket',
    displayName: 'S3 Bucket',
    mimeTypes: ['application/x-s3-bucket'],
    extensions: [],
    icon: bucketIcon
  });

  // Handle settings
  let pathPrefix = 's3://';
  let showHiddenFilesState = false; // Filter state

  // Manually create the file browser to use custom renderer
  const model = new FilterFileBrowserModel({
    manager,
    driveName: drive.name,
    refreshInterval: 300000,
    filter: value => {
      // Return null to exclude, {} (or undefined/partial match) to include.
      // Filter out dotfiles unless showHiddenFilesState is true.
      if (showHiddenFilesState) {
        return {};
      }
      if (value.name.startsWith('.')) {
        return null;
      }
      return {};
    }
  });

  const renderer = new S3DirListingRenderer();

  const browser = new FileBrowser({
    id: NAMESPACE,
    model,
    renderer
  });

  // Hide the Modified column - this properly recalculates column widths
  browser.showLastModifiedColumn = false;

  // Add to tracker for global commands (like copy path)
  (factory.tracker as any).add(browser);

  // Disable file checkboxes at the source (JupyterLab 4 API)
  (browser as any).showFileCheckboxes = false;
  // Enable filtering (initially hidden, toggled via toolbar button)
  (browser as any).showFileFilter = false;

  const s3Browser = new S3FileBrowser(browser, drive, manager);

  // Add command to toggle the extension sidebar
  const toggleCommand = 'jupyterlab-bucket-explorer:toggle';
  app.commands.addCommand(toggleCommand, {
    label: 'Toggle Bucket Explorer',
    execute: () => {
      app.shell.activateById(s3Browser.id);
    }
  });
  app.commands.addKeyBinding({
    command: toggleCommand,
    keys: ['Accel Shift Z'],
    selector: 'body'
  });

  s3Browser.title.icon = s3Icon;
  s3Browser.title.caption = 'Bucket Explorer (Ctrl+Shift+Z)';

  s3Browser.id = 's3-file-browser';

  // Add the file browser widget to the application restorer.
  restorer.add(s3Browser, NAMESPACE);
  app.shell.add(s3Browser, 'left', { rank: 101 });

  // Create filter function for hidden files
  const createHiddenFilesFilter = () => (value: Contents.IModel) => {
    // Return null to exclude, {} (or undefined/partial match) to include.
    // Filter out dotfiles unless showHiddenFilesState is true.
    if (showHiddenFilesState) {
      return {};
    }
    if (value.name.startsWith('.')) {
      return null;
    }
    return {};
  };

  const loadSettings = (settings: ISettingRegistry.ISettings): void => {
    const showFileCheckboxes = settings.get('showFileCheckboxes')
      .composite as boolean;
    const refreshIntervalMs = settings.get('refreshIntervalMs')
      .composite as number;
    const showHiddenFiles = settings.get('showHiddenFiles')
      .composite as boolean;
    pathPrefix = settings.get('pathPrefix').composite as string;
    const defaultRegion = settings.get('defaultRegion').composite as string;

    // Local state update
    showHiddenFilesState = showHiddenFiles;

    // Apply Settings
    (browser as any).showFileCheckboxes = showFileCheckboxes;
    // Apply refresh interval to model
    (model as any).refreshInterval = refreshIntervalMs;
    // Apply default region
    s3Browser.defaultRegion = defaultRegion;

    // Update filter function with new state (must call setFilter, not rely on closure)
    model.setFilter(createHiddenFilesFilter());

    // Trigger refresh to apply filter - force full reload
    void model.cd(model.path);

    console.log(
      `[Bucket Explorer] Settings loaded: interval=${refreshIntervalMs}, check=${showFileCheckboxes}, prefix=${pathPrefix}, hidden=${showHiddenFiles}, region=${defaultRegion}`
    );
  };

  if (settingRegistry) {
    settingRegistry
      .load(PLUGIN_ID)
      .then(settings => {
        loadSettings(settings);
        settings.changed.connect(loadSettings);
        // Initialize connection service with settings
        connectionService.initialize(settings);
      })
      .catch((reason: Error) => {
        console.error(reason.message);
      });
  }

  // Add Copy S3 URI command
  const copyUriCommand = 'jupyterlab-bucket-explorer:copy-uri';
  app.commands.addCommand(copyUriCommand, {
    label: 'Copy S3 URI',
    icon: s3Icon,
    execute: async () => {
      const items = browser.selectedItems();
      const next = items.next();
      if (next && !next.done) {
        const item = next.value;
        // Construct URI: prefix + path (removing drive name if present or handling absolute paths)
        // Item path in S3Drive is usually "drive:bucket/key"
        // We want "bucket/key"
        const parts = item.path.split(':');
        const relativePath =
          parts.length > 1 ? parts.slice(1).join(':') : item.path;

        // Get current pathPrefix from settings (refresh to get latest value)
        let currentPathPrefix = 's3://';
        if (settingRegistry) {
          try {
            const settings = await settingRegistry.load(PLUGIN_ID);
            currentPathPrefix = settings.get('pathPrefix').composite as string;
          } catch (err) {
            console.warn('Failed to load pathPrefix from settings:', err);
          }
        }

        const uri = `${currentPathPrefix}${relativePath}`;
        Clipboard.copyToSystem(uri);
      }
    }
  });

  // Add to context menu
  app.contextMenu.addItem({
    command: copyUriCommand,
    selector: '.jp-S3Browser .jp-DirListing-item[data-isdir]',
    rank: 10
  });
  app.contextMenu.addItem({
    command: copyUriCommand,
    selector: '.jp-S3Browser .jp-DirListing-item[data-isfile]',
    rank: 10
  });

  return;
}

export default fileBrowserPlugin;
