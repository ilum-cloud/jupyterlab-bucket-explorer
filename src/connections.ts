/**
 * Connection management for multi-cloud storage support.
 *
 * This module provides types and services for managing multiple
 * storage connections (S3, future: GCS, Azure, etc.)
 */

import { Signal, ISignal } from '@lumino/signaling';
import { ServerConnection } from '@jupyterlab/services';
import { URLExt } from '@jupyterlab/coreutils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Notification } from '@jupyterlab/apputils';

/**
 * Supported storage provider types.
 * This is extensible for future cloud providers.
 */
export type ProviderType = 's3' | 'gcs' | 'azure' | 'hdfs';

/**
 * Interface for a storage connection configuration.
 */
export interface IStorageConnection {
  /** Unique identifier for the connection */
  id: string;
  /** Human-readable name for the connection */
  name: string;
  /** The type of storage provider */
  providerType: ProviderType;
  /** Optional endpoint URL (required for non-AWS S3) */
  url?: string;
  /** Access key / Client ID */
  accessKey?: string;
  /** Secret key (may be masked in responses) */
  secretKey?: string;
  /** Region for the storage service */
  region?: string;
  /** Whether this is the default connection */
  isDefault?: boolean;
}

/**
 * Response from connection operations.
 */
interface IConnectionResponse {
  success: boolean;
  id?: string;
  connection?: IStorageConnection;
  error?: number | string;
  message?: string;
}

/**
 * Service for managing storage connections.
 *
 * This service handles CRUD operations for connections and
 * maintains the currently active connection for requests.
 */
export class ConnectionService {
  private _connections: IStorageConnection[] = [];
  private _activeConnectionId: string | null = null;
  private _connectionChanged = new Signal<this, string | null>(this);
  private _connectionsUpdated = new Signal<this, IStorageConnection[]>(this);
  private _isInitialized = false;
  private _settings: ISettingRegistry.ISettings | null = null;
  private _requestTimeoutMs = 30000;

  /**
   * Signal emitted when the active connection changes.
   */
  get connectionChanged(): ISignal<this, string | null> {
    return this._connectionChanged;
  }

  /**
   * Signal emitted when the connections list is updated.
   */
  get connectionsUpdated(): ISignal<this, IStorageConnection[]> {
    return this._connectionsUpdated;
  }

  /**
   * Get the currently active connection ID.
   */
  get activeConnectionId(): string | null {
    return this._activeConnectionId;
  }

  /**
   * Set the active connection ID.
   * Emits connectionChanged signal if the ID changes.
   */
  set activeConnectionId(id: string | null) {
    if (this._activeConnectionId !== id) {
      this._activeConnectionId = id;
      this._connectionChanged.emit(id);
    }
  }

  /**
   * Get the list of all connections.
   */
  get connections(): IStorageConnection[] {
    return [...this._connections];
  }

  /**
   * Check if the service has been initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Get the active connection object.
   */
  get activeConnection(): IStorageConnection | undefined {
    if (!this._activeConnectionId) {
      // return this._connections.find(c => c.isDefault);
      // Return the first one if no explicit active ID, or explicit default
      const defaultConn = this._connections.find(c => c.isDefault);
      if (defaultConn) {
        return defaultConn;
      }
      if (this._connections.length > 0) {
        return this._connections[0];
      }
      return undefined;
    }
    return this._connections.find(c => c.id === this._activeConnectionId);
  }

  private _initialized = new Signal<this, boolean>(this);

  /**
   * Signal emitted when the service is fully initialized (including bootstrap).
   */
  get initialized(): ISignal<this, boolean> {
    return this._initialized;
  }

  /**
   * Initialize the service with settings.
   */
  async initialize(settings?: ISettingRegistry.ISettings): Promise<void> {
    if (this._isInitialized) {
      return;
    }

    if (settings) {
      this._settings = settings;
      this._loadFromSettings();
      settings.changed.connect(() => {
        this._loadFromSettings();
      });

      // Attempt to bootstrap from backend ENVs if configured
      // We await this to ensure we are "ready" only after checking envs
      try {
        await this.bootstrapFromBackend();
      } catch (err) {
        console.warn('Failed to bootstrap connections from backend:', err);
      }
    } else {
      // Fallback or error? For now just log
      console.warn(
        'ConnectionService initialized without SettingsRegistry. Persistence disabled.'
      );
    }

    this._isInitialized = true;

    // Set active connection to default if not set
    if (!this._activeConnectionId && this._connections.length > 0) {
      const defaultConn = this._connections.find(c => c.isDefault);
      this._activeConnectionId = defaultConn?.id || this._connections[0].id;
    }

    // Announce we are ready
    this._initialized.emit(true);
  }

  /**
   * Bootstrap connections from the backend (environment variables).
   * This is called on initialization to ensure that if the user has
   * provided S3_* env vars, they are reflected in the settings.
   */
  async bootstrapFromBackend(): Promise<void> {
    try {
      const settings = ServerConnection.makeSettings();
      const response = await ServerConnection.makeRequest(
        URLExt.join(
          settings.baseUrl,
          'jupyterlab-bucket-explorer/connections?mask=false'
        ),
        {},
        settings
      );

      if (!response.ok) {
        console.warn('Failed to fetch connections from backend for bootstrap.');
        return;
      }

      const data = await response.json();
      const backendConnections: IStorageConnection[] = data.connections || [];

      if (backendConnections.length === 0) {
        return;
      }

      let settingsChanged = false;
      const currentConnections = [...this._connections];

      for (const backendConn of backendConnections) {
        // Check if this connection roughly exists (by ID or Name)
        const exists = currentConnections.some(
          c => c.id === backendConn.id || c.name === backendConn.name
        );

        if (!exists) {
          console.log(
            'Bootstrapping connection from backend:',
            backendConn.name
          );
          // Ensure we don't accidentally override multiple defaults if settings already has one
          if (
            backendConn.isDefault &&
            currentConnections.some(c => c.isDefault)
          ) {
            backendConn.isDefault = false;
          }
          currentConnections.push(backendConn);
          settingsChanged = true;
          Notification.success(`Bootstrapped connection: ${backendConn.name}`);
        } else {
          // FORCE UPDATE: If it exists, overwrite it to ensure schema compliance (e.g. fix snake_case keys)
          console.log('Updating bootstrapped connection:', backendConn.name);
          const index = currentConnections.findIndex(
            c => c.id === backendConn.id || c.name === backendConn.name
          );
          if (index !== -1) {
            // Preserve local overrides if needed? For now, Env source of truth wins for these properties.
            // We might want to preserve some user-set properties if we were advanced, but for now, fix the corruption.

            // If the existing one is default, preserve that unless backend says otherwise?
            // Actually backend Env connection says isDefault=True usually.

            // Let's just swap it, but handle ID match carefully.
            // If we found by Name but ID differs, we might create duplicate if we are not careful?
            // The backend generates ID based on UUID now.
            // If we allow ID update, we must ensure we don't have ID collision.

            // Simplest safe update:
            const existing = currentConnections[index];

            // Update fields
            currentConnections[index] = {
              ...existing,
              ...backendConn
              // If backend ID is different but name is same, should we adopt backend ID?
              // Yes, mostly.
            };
            settingsChanged = true;
            // Optional: Notification.info(`Updated connection: ${backendConn.name}`);
          }
        }
      }

      if (settingsChanged) {
        this._connections = currentConnections;
        await this._saveToSettings();
        console.log('Bootstrapped connections saved to settings.');
      }
    } catch (error) {
      console.error('Error bootstrapping connections from backend:', error);
      Notification.error(
        `Failed to bootstrap environment connections: ${error}`
      );
    }
  }

  private _loadFromSettings(): void {
    if (!this._settings) {
      return;
    }

    this._requestTimeoutMs =
      (this._settings.get('requestTimeoutMs').composite as number) || 30000;

    let distinct = this._settings.get('connections').composite as unknown as
      | IStorageConnection[]
      | undefined;

    // Auto-generate IDs if missing
    let settingsChanged = false;
    if (distinct) {
      distinct = distinct.map(c => {
        if (!c.id) {
          console.log('Auto-generating ID for connection:', c.name);
          settingsChanged = true;
          return { ...c, id: Private.uuid() };
        }
        return c;
      });
    }

    // Filter out invalid entries if any (must have name at least, ID is now guaranteed)
    this._connections = distinct ? distinct.filter(c => c.name) : [];

    console.log(
      `[ConnectionService] Loaded ${this._connections.length} connections from settings:`,
      this._connections
    );

    if (settingsChanged) {
      // Persist the generated IDs back so they don't change on next reload
      void this._saveToSettings();
    }

    this._connectionsUpdated.emit(this._connections);

    // Re-validate active connection
    if (
      this._activeConnectionId &&
      !this._connections.find(c => c.id === this._activeConnectionId)
    ) {
      this._activeConnectionId = null;
      // Reset to default?
      const defaultConn = this._connections.find(c => c.isDefault);
      if (defaultConn) {
        this.activeConnectionId = defaultConn.id;
      } else if (this._connections.length > 0) {
        this.activeConnectionId = this._connections[0].id;
      }
    }
  }

  private async _saveToSettings(): Promise<void> {
    if (!this._settings) {
      console.warn(
        '[ConnectionService] No settings registry available. Save aborted.'
      );
      return;
    }
    try {
      // Validate data against schema requirements (basic check)
      // Schema requires: name, accessKey, secretKey
      const cleanConnections = this._connections.map(c => ({
        ...c,
        id: c.id,
        name: c.name || 'Unnamed',
        providerType: c.providerType || 's3',
        // Ensure required fields are present (even if empty strings) to satisfy schema
        accessKey: c.accessKey || '',
        secretKey: c.secretKey || '',
        url: c.url || undefined,
        region: c.region || undefined,
        isDefault: !!c.isDefault
      }));

      await this._settings.set('connections', cleanConnections as any);
      console.log(
        '[ConnectionService] Connections saved to settings successfully.'
      );
    } catch (err) {
      console.error('[ConnectionService] Failed to save settings:', err);
      Notification.error(
        'Failed to save connection to settings. Check console for details.'
      );
      throw err;
    }
  }

  /**
   * Refresh the connections list (compatibility method).
   * In the new settings-based model, this just triggers a reload from settings
   * or returns the current list.
   */
  async refreshConnections(): Promise<IStorageConnection[]> {
    this._loadFromSettings();
    return this._connections;
  }

  /**
   * List all connections.
   */
  async listConnections(): Promise<IStorageConnection[]> {
    return this._connections;
  }

  /**
   * Add a new connection.
   */
  /**
   * Add a new connection.
   */
  async addConnection(
    connection: Omit<IStorageConnection, 'id'>
  ): Promise<IConnectionResponse> {
    try {
      // Generate a robust UUID-like ID
      const newId = Private.uuid();
      const newConnection: IStorageConnection = { ...connection, id: newId };

      // Handle default flag logic locally
      if (newConnection.isDefault) {
        this._connections.forEach(c => (c.isDefault = false));
      }

      this._connections.push(newConnection);
      await this._saveToSettings();

      return { success: true, id: newId, connection: newConnection };
    } catch (error) {
      console.error('Failed to add connection:', error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Update an existing connection.
   */
  async updateConnection(
    id: string,
    updates: Partial<IStorageConnection>
  ): Promise<IConnectionResponse> {
    try {
      const index = this._connections.findIndex(c => c.id === id);
      if (index === -1) {
        return { success: false, message: 'Connection not found' };
      }

      const updated = { ...this._connections[index], ...updates };

      if (updated.isDefault) {
        this._connections.forEach(c => (c.isDefault = false));
      }

      this._connections[index] = updated;
      await this._saveToSettings();

      return { success: true, connection: updated };
    } catch (error) {
      console.error('Failed to update connection:', error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Delete a connection.
   */
  async deleteConnection(id: string): Promise<IConnectionResponse> {
    try {
      const initialLength = this._connections.length;
      this._connections = this._connections.filter(c => c.id !== id);

      if (this._connections.length === initialLength) {
        return { success: false, message: 'Connection not found' };
      }

      await this._saveToSettings();

      // If we deleted the active connection, reset to default
      if (this._activeConnectionId === id) {
        this._activeConnectionId = null;

        if (this._connections.length > 0) {
          const defaultConn = this._connections.find(c => c.isDefault);
          this.activeConnectionId = defaultConn?.id || this._connections[0].id;
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to delete connection:', error);
      return { success: false, message: String(error) };
    }
  }

  /**
   * Test if a connection is valid.
   */
  async testConnection(id: string): Promise<boolean> {
    // For settings-based connections, we can reuse testCredentials
    // BUT: We need to handle the case where we don't know the secrets?
    // Actually, in Settings-based approach, frontend HAS the secrets in this._connections.
    // So we can just call testCredentials with the data we have.

    const conn = this._connections.find(c => c.id === id);
    if (!conn) {
      return false;
    }

    return this.testCredentials(
      conn.url,
      conn.accessKey || '',
      conn.secretKey || '',
      conn.region
    );
  }

  /**
   * Test credentials without saving.
   */
  async testCredentials(
    url: string | undefined,
    accessKey: string,
    secretKey: string,
    region?: string
  ): Promise<boolean> {
    const settings = ServerConnection.makeSettings();
    const timeoutVal = this._requestTimeoutMs || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutVal);

    try {
      // Use the 'test' endpoint which is stateless/ephemeral compatible?
      // Actually my backend changes didn't explicitly touch /test endpoint to handle headers?
      // Wait, handlers.py POST /connections with path="test" handles body params.
      // So this should still work as is, because it sends body.

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
            region
          }),
          signal: controller.signal
        },
        settings
      );

      clearTimeout(timeoutId);

      const data = await response.json();
      return data.success === true;
    } catch (error) {
      if ((error as any).name === 'AbortError') {
        console.error(`Connection test timed out after ${timeoutVal}ms`);
        Notification.error(`Connection test timed out after ${timeoutVal}ms`);
      } else {
        console.error('Failed to test credentials:', error);
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Set a connection as the default.
   */
  async setDefault(id: string): Promise<boolean> {
    // Reuse update
    const res = await this.updateConnection(id, { isDefault: true });
    return res.success;
  }

  /**
   * Check if there are any connections configured.
   */
  hasConnections(): boolean {
    return this._connections.length > 0;
  }

  /**
   * Get headers to include in requests for the active connection.
   */
  getConnectionHeaders(): Record<string, string> {
    const active = this.activeConnection;
    if (active) {
      // Send credentials headers for stateless backend
      const headers: Record<string, string> = {};
      if (active.url) {
        headers['X-S3-Endpoint'] = active.url;
      }
      if (active.accessKey) {
        headers['X-S3-Access-Key'] = active.accessKey;
      }
      if (active.secretKey) {
        headers['X-S3-Secret-Key'] = active.secretKey;
      }
      if (active.region) {
        headers['X-S3-Region'] = active.region;
      }

      // Also send connection ID just in case
      headers['X-Connection-Id'] = active.id;

      return headers;
    }
    return {};
  }
}

/**
 * Singleton instance of the connection service.
 */
export const connectionService = new ConnectionService();

namespace Private {
  /**
   * Generate a simple UUID-like string.
   */
  export function uuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
