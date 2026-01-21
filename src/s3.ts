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
 * Custom error class for S3 operations
 */
export class S3Error extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

/**
 * Check response for errors and throw S3Error if found
 */
function checkResponse(response: any): void {
  if (response.error) {
    throw new S3Error(response.message || 'Unknown S3 error', response.error);
  }
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
          path
        ),
        { method: 'POST', body: formData, headers: getConnectionHeaders() },
        settings
      )
    ).json();

    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(`Upload failed: ${error}`);
  }
}

export async function copyFile(
  oldPath: string,
  newPath: string
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          newPath
        ),
        {
          method: 'PUT',
          headers: {
            ...getConnectionHeaders(),
            'X-Custom-S3-Copy-Src': oldPath
          }
        },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(`Copy failed: ${error}`);
  }
}

export async function moveFile(
  oldPath: string,
  newPath: string
): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          newPath
        ),
        {
          method: 'PUT',
          headers: {
            ...getConnectionHeaders(),
            'X-Custom-S3-Move-Src': oldPath
          }
        },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(`Move failed: ${error}`);
  }
}

export async function deleteFile(
  path: string,
  recursive = false
): Promise<any> {
  const settings = ServerConnection.makeSettings();
  const headers: Record<string, string> = { ...getConnectionHeaders() };
  if (recursive) {
    headers['X-Custom-S3-Recursive'] = 'true';
  }

  try {
    const response = await (
      await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/files',
          path
        ) + (recursive ? '?recursive=true' : ''),
        { method: 'DELETE', headers },
        settings
      )
    ).json();
    checkResponse(response);
    return response;
  } catch (error) {
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(`Delete failed: ${error}`);
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
        URLExt.join(settings.baseUrl, 'jupyterlab-bucket-explorer/files', path),
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
    if (error instanceof S3Error) {
      throw error;
    }
    throw new S3Error(`Write failed: ${error}`);
  }
}

export async function createDirectory(path: string): Promise<Contents.IModel> {
  const settings = ServerConnection.makeSettings();
  await (
    await ServerConnection.makeRequest(
      URLExt.join(settings.baseUrl, 'jupyterlab-bucket-explorer/files', path),
      {
        method: 'PUT',
        headers: { ...getConnectionHeaders(), 'X-Custom-S3-Is-Dir': 'true' }
      },
      settings
    )
  ).json();

  return {
    type: 'directory',
    path: path.trim(),
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
  const response = await (
    await ServerConnection.makeRequest(
      URLExt.join(settings.baseUrl, 'jupyterlab-bucket-explorer/files', path),
      {
        method: 'GET',
        headers: { ...getConnectionHeaders(), 'X-Custom-S3-Is-Dir': 'true' }
      },
      settings
    )
  ).json();
  const contents: Contents.IModel = {
    type: 'directory',
    path: path.trim(),
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
      URLExt.join(settings.baseUrl, 'jupyterlab-bucket-explorer/files', path),
      { method: 'GET', headers: getConnectionHeaders() },
      settings
    )
  ).json();
  return response;
  // TODO: error handling
}
