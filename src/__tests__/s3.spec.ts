import { Contents, ServerConnection } from '@jupyterlab/services';
import { URLExt } from '@jupyterlab/coreutils';

import * as s3 from '../storage';

describe('s3 api helpers', () => {
  const baseUrl = 'http://localhost:8888/';
  const makeRequest = jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(async (_url, _init, _settings) => {
      return {
        json: async () => ({})
      } as Response;
    });

  beforeAll(() => {
    jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue({
      baseUrl,
      wsUrl: '',
      appUrl: '',
      token: '',
      xsrfToken: ''
    } as any);
  });

  beforeEach(() => {
    makeRequest.mockClear();
  });

  it('writeFile constructs expected request', async () => {
    const settings = { baseUrl } as ServerConnection.ISettings;
    jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue(settings);

    makeRequest.mockImplementationOnce(async (url, init) => {
      expect(url).toBe(
        URLExt.join(
          baseUrl,
          'jupyterlab-bucket-explorer/files',
          'bucket/file.txt'
        )
      );
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBe(JSON.stringify({ content: 'hello' }));
      return {
        json: async () => ({
          path: 'bucket/file.txt',
          type: 'file',
          content: 'hello'
        })
      } as Response;
    });

    const result = await s3.writeFile('bucket/file.txt', 'hello');
    expect(result.path).toBe('bucket/file.txt');
  });

  it('ls transforms response into a directory model', async () => {
    const settings = { baseUrl } as ServerConnection.ISettings;
    jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue(settings);

    makeRequest.mockImplementationOnce(async () => {
      return {
        json: async () => [
          {
            name: 'file.txt',
            path: 'bucket/file.txt',
            type: 'file',
            mimetype: ''
          }
        ]
      } as Response;
    });

    const model = await s3.ls('bucket');
    expect(model.type).toBe('directory');
    expect((model.content as Contents.IModel[])[0].path).toBe(
      'bucket/file.txt'
    );
  });

  it('deleteFile sets recursive header', async () => {
    const settings = { baseUrl } as ServerConnection.ISettings;
    jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue(settings);

    makeRequest.mockImplementationOnce(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Storage-Recursive']).toBe('true');
      return { json: async () => ({}) } as Response;
    });

    await s3.deleteFile('bucket/path', true);
  });

  it('throws S3Error when API returns error', async () => {
    const settings = { baseUrl } as ServerConnection.ISettings;
    jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue(settings);

    makeRequest.mockImplementationOnce(async () => {
      return {
        json: async () => ({ error: 500, message: 'boom' })
      } as Response;
    });

    await expect(s3.writeFile('bucket/file.txt', 'hello')).rejects.toThrow(
      'boom'
    );
  });
});
