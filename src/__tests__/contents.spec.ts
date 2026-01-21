jest.mock('@jupyterlab/apputils', () => ({
  Notification: {
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    dismiss: jest.fn()
  },
  Dialog: {
    cancelButton: jest.fn(),
    warnButton: jest.fn()
  },
  showDialog: jest.fn().mockResolvedValue({ button: { accept: false } })
}));

import { ServerConnection } from '@jupyterlab/services';

// Mock ServerConnection to avoid fetch issues
jest.spyOn(ServerConnection, 'makeSettings').mockReturnValue({
  baseUrl: 'http://localhost:8888/',
  wsUrl: '',
  appUrl: '',
  token: '',
  xsrfToken: ''
} as any);

describe('S3Drive', () => {
  it('uses S3 drive name', () => {
    const globalAny: any = global;
    globalAny.fetch = jest.fn();
    globalAny.Request = class {};
    globalAny.Headers = class {};
    globalAny.Response = class {};
    const { S3Drive } = require('../contents') as typeof import('../contents');
    const drive = new S3Drive({} as any);
    expect(drive.name).toBe('S3');
  });
});
