import { Signal, ISignal } from '@lumino/signaling';
import { PathExt } from '@jupyterlab/coreutils';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { Contents, ServerConnection } from '@jupyterlab/services';
import * as base64js from 'base64-js';
import * as storage from './storage';
import { Notification, Dialog, showDialog } from '@jupyterlab/apputils';

/**
 * A Contents.IDrive implementation for s3-api-compatible object storage.
 */
export class S3Drive implements Contents.IDrive {
  /**
   * Construct a new drive object.
   *
   * @param options - The options used to initialize the object.
   */
  constructor(registry: DocumentRegistry) {
    this.serverSettings = ServerConnection.makeSettings();
    this._registry = registry;
  }

  public _registry: DocumentRegistry;

  /**
   * The name of the drive.
   */
  get name(): 'S3' {
    return 'S3';
  }

  /**
   * Settings for the notebook server.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * A signal emitted when a file operation takes place.
   */
  get fileChanged(): ISignal<this, Contents.IChangedArgs> {
    return this._fileChanged;
  }

  /**
   * Test whether the manager has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    Signal.clearData(this);
  }

  /**
   * Get a file or directory.
   */
  async get(
    path: string,
    options?: Contents.IFetchOptions
  ): Promise<Contents.IModel> {
    if (options && (options.type === 'file' || options.type === 'notebook')) {
      const s3Contents = await storage.read(path);
      const types = this._registry.getFileTypesForPath(path);
      const fileType =
        types.length === 0
          ? (this._registry.getFileType('text') ?? undefined)
          : types[0];
      const mimetype = fileType.mimeTypes[0];
      const format = fileType.fileFormat;
      let parsedContent;
      switch (format) {
        case 'text':
          parsedContent = Private.b64DecodeUTF8(s3Contents.content);
          break;
        case 'base64':
          parsedContent = s3Contents.content;
          break;
        case 'json':
          parsedContent = JSON.parse(Private.b64DecodeUTF8(s3Contents.content));
          break;
        default:
          throw new Error(`Unexpected file format: ${fileType.fileFormat}`);
      }

      const contents: Contents.IModel = {
        type: 'file',
        path,
        name: '',
        format,
        content: parsedContent,
        created: '',
        writable: true,
        last_modified: '',
        mimetype
      };

      return contents;
    } else {
      return await storage.ls(path);
    }
  }

  /**
   * Get an encoded download url given a file path.
   * This method triggers the download directly with the correct filename.
   */
  async getDownloadUrl(path: string): Promise<string> {
    try {
      const s3Contents = await storage.read(path);
      const bytes = base64js.toByteArray(s3Contents.content.replace(/\n/g, ''));

      // Get MIME type from registry for correct file handling
      const types = this._registry.getFileTypesForPath(path);
      const fileType = types.length > 0 ? types[0] : undefined;
      const mimeType = fileType?.mimeTypes?.[0] || 'application/octet-stream';

      const blob = new Blob([bytes as any], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);

      // Extract filename from path
      const filename = path.split('/').pop() || 'download';

      // Create a hidden anchor and trigger download with correct filename
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Revoke the blob URL after a short delay to allow download to start
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

      // Return dummy URL to prevent JupyterLab from triggering a second download
      // We handled the download manually above to ensure correct filename
      return 'javascript:void(0)';
    } catch (e) {
      const msg = `Failed to prepare download for ${path}`;
      Notification.error(msg);
      throw e;
    }
  }

  /**
   * Create a new untitled file or directory in the specified directory path.
   */
  async newUntitled(
    options: Contents.ICreateOptions = {}
  ): Promise<Contents.IModel> {
    let s3contents;
    const basename = 'untitled';
    let filename = basename;
    const existingFiles = await storage.ls(options.path as string);
    const existingFilenames = existingFiles.content.map(
      (content: Contents.IModel) => content.name
    );
    let uniqueSuffix = 0;
    while (existingFilenames.includes(filename)) {
      uniqueSuffix++;
      filename = basename + uniqueSuffix;
    }
    switch (options.type) {
      case 'file':
        s3contents = await storage.writeFile(options.path + '/' + filename, '');
        break;
      case 'directory':
        if (options.path === '') {
          throw new Error('Bucket creation is not currently supported.');
        }
        s3contents = await storage.createDirectory(options.path + '/' + filename);
        break;
      default:
        throw new Error(`Unexpected type: ${options.type}`);
    }
    const types = this._registry.getFileTypesForPath(s3contents.path);
    const fileType =
      types.length === 0
        ? (this._registry.getFileType('text') ?? undefined)
        : types[0];
    const mimetype = fileType.mimeTypes[0];
    const format = fileType.fileFormat;
    const contents: Contents.IModel = {
      type: options.type,
      path: options.path as string,
      name: filename,
      format,
      content: '',
      created: '',
      writable: true,
      last_modified: '',
      mimetype
    };

    this._fileChanged.emit({
      type: 'new',
      oldValue: null,
      newValue: contents
    });
    return contents;
  }

  /**
   * Delete a file.
   */
  async delete(path: string): Promise<void> {
    try {
      // Try to delete without recursive first
      await storage.deleteFile(path, false);

      this._fileChanged.emit({
        type: 'delete',
        oldValue: { path },
        newValue: null
      });
    } catch (error) {
      // Check if error is DIR_NOT_EMPTY
      if (error instanceof Error && error.message.includes('DIR_NOT_EMPTY')) {
        // Show confirmation dialog
        const result = await this._showConfirmDialog(
          'Confirm Deletion',
          `Folder "${path}" contains files. Are you sure you want to delete it and all its contents?`
        );

        if (result.button.accept) {
          // User confirmed, delete recursively
          const notifyId = Notification.info(`Deleting ${path}...`, {
            autoClose: false
          });
          try {
            await storage.deleteFile(path, true);
            this._fileChanged.emit({
              type: 'delete',
              oldValue: { path },
              newValue: null
            });

            Notification.dismiss(notifyId);
            Notification.success(`Successfully deleted ${path}`);
          } catch (e) {
            Notification.dismiss(notifyId);
            throw e;
          }
        } else {
          // User cancelled
          throw new Error('Deletion cancelled by user');
        }
      } else {
        // Other error, re-throw (but also emit refresh just in case?)
        throw error;
      }
    }
  }

  /**
   * Show a confirmation dialog
   */
  private async _showConfirmDialog(title: string, body: string): Promise<any> {
    const result = await showDialog({
      title,
      body,
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Delete' })]
    });
    return result;
  }

  /**
   * Rename a file or directory.
   */
  async rename(path: string, newPath: string): Promise<Contents.IModel> {
    if (!path.includes('/')) {
      throw Error('Renaming of buckets is not currently supported.');
    }
    const notifyId = Notification.info(`Renaming ${path} to ${newPath}...`, {
      autoClose: false
    });
    try {
      const response = await storage.moveFile(path, newPath);

      // Use type from backend response (detected via s3fs.isdir())
      const isDirectory = response.type === 'directory';
      const itemType = isDirectory ? 'directory' : 'file';

      // Construct Contents.IModel from the new path
      const types = this._registry.getFileTypesForPath(newPath);
      const fileType = types.length === 0
        ? (this._registry.getFileType('text') ?? undefined)
        : types[0];

      const content: Contents.IModel = {
        type: itemType,
        path: newPath,
        name: PathExt.basename(newPath),
        format: isDirectory ? 'json' : (fileType?.fileFormat || 'text'),
        content: isDirectory ? [] : null,
        created: '',
        writable: true,
        last_modified: '',
        mimetype: isDirectory ? '' : (fileType?.mimeTypes?.[0] || '')
      };

      this._fileChanged.emit({
        type: 'rename',
        oldValue: { path },
        newValue: content
      });
      Notification.dismiss(notifyId);
      Notification.success('Rename successful');
      return content;
    } catch (e) {
      Notification.dismiss(notifyId);
      throw e;
    }
  }

  /**
   * Upload a file directly (bypassing conversion).
   */
  async upload(path: string, file: File): Promise<Contents.IModel> {
    const notifyId = Notification.info(`Uploading ${path}...`, {
      autoClose: false
    });
    try {
      const content = await storage.uploadFile(path, file);
      this._fileChanged.emit({
        type: 'save',
        oldValue: null,
        newValue: content
      });
      Notification.dismiss(notifyId);
      Notification.success(`Uploaded ${path}`);
      return content;
    } catch (e) {
      Notification.dismiss(notifyId);
      throw e;
    }
  }

  /**
   * Save a file.
   */
  async save(
    path: string,
    options: Partial<Contents.IModel> = {}
  ): Promise<Contents.IModel> {
    const notifyId = Notification.info(`Saving ${path}...`, {
      autoClose: false
    });
    try {
      let s3contents;
      let content = options.content;

      if (options.format === 'base64') {
        const bytes = base64js.toByteArray(options.content.replace(/\n/g, ''));
        const blob = new Blob([bytes as any]);
        const file = new File([blob], options.name || 'filename');
        s3contents = await storage.uploadFile(path, file);
      } else if (options.type === 'directory') {
        s3contents = await storage.createDirectory(path);
      } else {
        // Update content if needs stringification but only if not base64 (already handled)
        if (options.format === 'json') {
          content = JSON.stringify(options.content);
        }
        s3contents = await storage.writeFile(path, content);
      }

      const types = this._registry.getFileTypesForPath(s3contents.path);
      const fileType =
        types.length === 0
          ? (this._registry.getFileType('text') ?? undefined)
          : types[0];
      const mimetype = fileType.mimeTypes[0];
      const format = fileType.fileFormat;

      // We return 'content' which is the original content from options (or updated if json)
      // Actually strictly speaking we should return what we saved or what matches the model
      // But standard implementation usually mirrors inputs.

      const contents: Contents.IModel = {
        type: options.type as string,
        path: options.path as string,
        name: options.name as string,
        format,
        content: options.content, // Use original content
        created: '',
        writable: true,
        last_modified: '',
        mimetype
      };

      this._fileChanged.emit({
        type: 'save',
        oldValue: null,
        newValue: contents
      });
      Notification.dismiss(notifyId);
      if (options.type === 'file') {
        Notification.success(`Saved ${path}`);
      }
      return contents;
    } catch (e) {
      Notification.dismiss(notifyId);
      throw e;
    }
  }

  /**
   * Copy a file into a given directory.
   */
  async copy(fromFile: string, toDir: string): Promise<Contents.IModel> {
    const notifyId = Notification.info(`Copying ${fromFile}...`, {
      autoClose: false
    });
    try {
      let basename = PathExt.basename(fromFile).split('.')[0];
      basename += '-copy';
      const ext = PathExt.extname(fromFile);
      const newPath = '/' + toDir + '/' + basename + ext;
      const response = await storage.copyFile(fromFile, newPath);


      // Use type from backend response (detected via s3fs.isdir())
      const isDirectory = response.type === 'directory';
      const itemType = isDirectory ? 'directory' : 'file';

      // Construct Contents.IModel from the new path
      const types = this._registry.getFileTypesForPath(newPath);
      const fileType = types.length === 0
        ? (this._registry.getFileType('text') ?? undefined)
        : types[0];

      const content: Contents.IModel = {
        type: itemType,
        path: newPath.startsWith('/') ? newPath.slice(1) : newPath,
        name: basename + ext,
        format: isDirectory ? 'json' : (fileType?.fileFormat || 'text'),
        content: isDirectory ? [] : null,
        created: '',
        writable: true,
        last_modified: '',
        mimetype: isDirectory ? '' : (fileType?.mimeTypes?.[0] || '')
      };

      this._fileChanged.emit({
        type: 'new',
        oldValue: null,
        newValue: content
      });
      Notification.dismiss(notifyId);
      Notification.success('Copy successful');
      return content;
    } catch (e) {
      Notification.dismiss(notifyId);
      throw e;
    }
  }

  /**
   * Create a checkpoint for a file.
   */
  async createCheckpoint(path: string): Promise<Contents.ICheckpointModel> {
    return { id: 'checkpoint', last_modified: new Date().toISOString() };
  }

  /**
   * List available checkpoints for a file.
   */
  async listCheckpoints(path: string): Promise<Contents.ICheckpointModel[]> {
    return [];
  }

  /**
   * Restore a file to a known checkpoint state.
   */
  async restoreCheckpoint(path: string, checkpointID: string): Promise<void> {
    throw Error('Not yet implemented');
  }

  /**
   * Delete a checkpoint for a file.
   */
  async deleteCheckpoint(path: string, checkpointID: string): Promise<void> {
    return void 0;
  }

  private _isDisposed = false;
  private _fileChanged = new Signal<this, Contents.IChangedArgs>(this);
}

/**
 * Private namespace for utility functions.
 */
namespace Private {
  const decoder = new TextDecoder('utf8');

  export function b64DecodeUTF8(str: string): string {
    const bytes = base64js.toByteArray(str.replace(/\n/g, ''));
    return decoder.decode(bytes);
  }
}
