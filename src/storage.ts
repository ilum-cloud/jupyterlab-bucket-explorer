// import { map, filter, toArray } from '@lumino/algorithm';

// import { PathExt } from '@jupyterlab/coreutils';

import { Contents, ServerConnection } from '@jupyterlab/services';

import { URLExt } from '@jupyterlab/coreutils';

import { connectionService } from './connections';

/**
 * Helper to get connection headers for requests.
 */
function getConnectionHeaders(): Record<string, string> {
  return connectionService.getConnectionHeaders();
}

/**
 * Custom error class for storage operations
 */
export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Check response for errors and throw StorageError if found
 */
function checkResponse(response: any): void {
  if (response.error) {
    throw new StorageError(response.message || 'Unknown S3 error', response.error);
  }
}

function normalizePath(path: string): string {
  if (!path) {
    return '';
  }

  let normalized = path.trim();

  if (normalized === '.' || normalized === '/') {
    return '';
  }

  const drivePrefixMatch = normalized.match(/^[A-Za-z0-9_-]+:/);
  if (drivePrefixMatch) {
    normalized = normalized.slice(drivePrefixMatch[0].length);
  }

  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  if (normalized === '.' || normalized === '/') {
    return '';
  }

  return normalized;
}

export async function uploadFile(
  path: string,
  file: File
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/upload',
          normalizePath(path)
        ),
        { method: 'POST', body: formData, headers: getConnectionHeaders() },
        settings
      )
    ).json();

    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`Upload failed: ${error}`);
  }
}

export async function copyFile(
  oldPath: string,
  newPath: string
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);
  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          normalizedNewPath
        ),
        {
          method: 'PUT',
          headers: {
            ...getConnectionHeaders(),
            'X-Storage-Copy-Src': normalizedOldPath
          }
        },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`Copy failed: ${error}`);
  }
}

export async function moveFile(
  oldPath: string,
  newPath: string
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);
  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          normalizedNewPath
        ),
        {
          method: 'PUT',
          headers: {
            ...getConnectionHeaders(),
            'X-Storage-Move-Src': normalizedOldPath
          }
        },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`Move failed: ${error}`);
  }
}

export async function deleteFile(
  path: string,
  recursive = false
): Promise<any> {
  const settings = ServerConnection.makeSettings();
  const normalizedPath = normalizePath(path);
  const headers: Record<string, string> = { ...getConnectionHeaders() };
  if (recursive) {
    headers['X-Storage-Recursive'] = 'true';
  }

  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          normalizedPath
        ) + (recursive ? '?recursive=true' : ''),
        { method: 'DELETE', headers },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`Delete failed: ${error}`);
  }
}

export async function writeFile(
  path: string,
  content: string
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          normalizePath(path)
        ),
        {
          method: 'PUT',
          body: JSON.stringify({ content }),
          headers: getConnectionHeaders()
        },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(`Write failed: ${error}`);
  }
}

export async function createDirectory(path: string): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const normalizedPath = normalizePath(path);
  await (
    await ServerConnection.makeRequest(
      URLExt.join(
        settings.baseUrl,
        'jupyterlab-bucket-explorer/files',
        normalizedPath
      ),
      {
        method: 'PUT',
        headers: { ...getConnectionHeaders(), 'X-Storage-Is-Dir': 'true' }
      },
      settings
    )
  ).json();

  return {
    type: 'directory',
    path: normalizedPath.trim(),
    name: 'Untitled',
    format: 'json',
    content: [],
    created: '',
    writable: true,
    last_modified: '',
    mimetype: ''
  };
  // return await ls(path);
}

function s3ToJupyterContents(s3Content: any): Contents.IModel {
  const result = {
    name: s3Content.name,
    path: s3Content.path,
    format: 'json', // this._registry.getFileType('text').fileFormat,
    type: s3Content.type,
    created: '',
    writable: true,
    last_modified: '',
    mimetype: s3Content.mimetype,
    content: s3Content.content
  } as Contents.IModel;
  return result;
}

export async function ls(path: string): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const normalizedPath = normalizePath(path);
  const response = await (
    await ServerConnection.makeRequest(
      URLExt.join(
        settings.baseUrl,
        'jupyterlab-bucket-explorer/files',
        normalizedPath
      ),
      {
        method: 'GET',
        headers: { ...getConnectionHeaders(), 'X-Storage-Is-Dir': 'true' }
      },
      settings
    )
  ).json();
  const contents: Contents.IModel = {
    type: 'directory',
    path: normalizedPath.trim(),
    name: '',
    format: 'json',
    content: response.map((s3Content: any) => {
      return s3ToJupyterContents(s3Content);
    }),
    created: '',
    writable: true,
    last_modified: '',
    mimetype: ''
  };
  return contents;
}

export async function read(path: string): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  const response = (
    await ServerConnection.makeRequest(
      URLExt.join(
        settings.baseUrl,
        'jupyterlab-bucket-explorer/files',
        normalizePath(path)
      ),
      { method: 'GET', headers: getConnectionHeaders() },
      settings
    )
  ).json();
  return response;
  // TODO: error handling
}
