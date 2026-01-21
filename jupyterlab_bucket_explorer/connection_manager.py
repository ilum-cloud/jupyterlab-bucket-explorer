"""
Connection Manager for managing multiple storage connections.

This module provides centralized management of storage connections,
including persistence, migration from legacy config, and provider instantiation.
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional

from .providers import ConnectionConfig, ProviderType, S3Provider, StorageProvider

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Manages multiple storage connections.

    Handles:
    - Persistence of connections to disk
    - Migration from legacy ~/.mc/config.json
    - Provider instantiation and caching
    - CRUD operations for connections
    """

    CONFIG_DIR = Path.home() / ".bucket-explorer"
    CONFIG_FILE = CONFIG_DIR / "connections.json"
    LEGACY_CONFIG_PATH = Path.home() / ".mc" / "config.json"

    def __init__(self, config_path: Optional[Path] = None):
        """
        Initialize the connection manager.

        Args:
            config_path: Optional custom path for config file (useful for testing)
        """
        if config_path:
            self.CONFIG_FILE = config_path
            self.CONFIG_DIR = config_path.parent

        self._connections: Dict[str, ConnectionConfig] = {}
        self._providers: Dict[str, StorageProvider] = {}
        self._load_connections()
        self._migrate_legacy_config()
        self._create_connection_from_env()

    def _create_connection_from_env(self) -> None:
        """Create connection from environment variables if present."""
        env_name = os.environ.get("S3_CONNECTION_NAME")
        env_endpoint = os.environ.get("S3_ENDPOINT")
        env_access_key = os.environ.get("S3_ACCESS_KEY")
        env_secret_key = os.environ.get("S3_SECRET_KEY")
        # Optional: S3_REGION
        env_region = os.environ.get("S3_REGION", "")

        if env_endpoint and env_access_key and env_secret_key:
            if not env_name:
                env_name = "Environment Connection"
                logger.info(
                    "S3_CONNECTION_NAME not set, using default: "
                    "'Environment Connection'"
                )

            # Check if connection with this name already exists to avoid duplicates
            for conn in self._connections.values():
                if conn.name == env_name:
                    logger.info(f"Connection '{env_name}' already exists via env vars.")
                    return

            logger.info(f"Creating connection '{env_name}' from environment variables.")

            # Create new connection config
            connection_config = ConnectionConfig(
                id=ConnectionConfig.generate_id(),
                name=env_name,
                provider_type=ProviderType.S3,
                url=env_endpoint,
                access_key=env_access_key,
                secret_key=env_secret_key,
                region=env_region,
                is_default=True,  # Make it default if created from env
            )

            self.add_connection(connection_config)

    def _ensure_config_dir(self) -> None:
        """Ensure the config directory exists."""
        self.CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    def _load_connections(self) -> None:
        """Load connections from the config file."""
        if not self.CONFIG_FILE.exists():
            return

        try:
            with open(self.CONFIG_FILE) as f:
                data = json.load(f)

            for conn_data in data.get("connections", []):
                config = ConnectionConfig.from_dict(conn_data)
                self._connections[config.id] = config

            logger.info(f"Loaded {len(self._connections)} connections from config")
        except Exception as e:
            logger.error(f"Failed to load connections: {e}")

    def _save_connections(self) -> None:
        """Save connections to the config file."""
        self._ensure_config_dir()

        data = {
            "version": "1",
            "connections": [
                conn.to_dict(mask_secrets=False) for conn in self._connections.values()
            ],
        }

        try:
            with open(self.CONFIG_FILE, "w") as f:
                json.dump(data, f, indent=2)
            logger.info(f"Saved {len(self._connections)} connections to config")
        except Exception as e:
            logger.error(f"Failed to save connections: {e}")

    def _migrate_legacy_config(self) -> None:
        """
        Migrate from legacy ~/.mc/config.json if it exists and we have no connections.

        The legacy format uses a single "storage" alias in the MinIO client format.
        """
        # Only migrate if we have no connections yet
        if self._connections:
            return

        if not self.LEGACY_CONFIG_PATH.exists():
            return

        try:
            with open(self.LEGACY_CONFIG_PATH) as f:
                legacy_data = json.load(f)

            aliases = legacy_data.get("aliases", {})
            storage_alias = aliases.get("storage", {})

            if storage_alias.get("accessKey") and storage_alias.get("secretKey"):
                # Create a default connection from legacy config
                config = ConnectionConfig(
                    id="default",
                    name="Default S3",
                    provider_type=ProviderType.S3,
                    url=storage_alias.get("url"),
                    access_key=storage_alias.get("accessKey"),
                    secret_key=storage_alias.get("secretKey"),
                    region=storage_alias.get("region"),
                    is_default=True,
                )
                self._connections[config.id] = config
                self._save_connections()
                logger.info("Migrated legacy config to new format")
        except Exception as e:
            logger.warning(f"Failed to migrate legacy config: {e}")

    def add_connection(self, config: ConnectionConfig) -> str:
        """
        Add or update a connection.

        Args:
            config: The connection configuration to add

        Returns:
            The connection ID
        """
        # If this is set as default, unset other defaults
        if config.is_default:
            for existing in self._connections.values():
                existing.is_default = False

        self._connections[config.id] = config
        # Invalidate cached provider
        self._providers.pop(config.id, None)
        self._save_connections()
        return config.id

    def remove_connection(self, connection_id: str) -> bool:
        """
        Remove a connection.

        Args:
            connection_id: The ID of the connection to remove

        Returns:
            True if connection was removed, False if not found
        """
        if connection_id not in self._connections:
            return False

        del self._connections[connection_id]
        self._providers.pop(connection_id, None)
        self._save_connections()
        return True

    def get_connection(self, connection_id: str) -> Optional[ConnectionConfig]:
        """
        Get connection config by ID.

        Args:
            connection_id: The ID of the connection

        Returns:
            The connection config or None if not found
        """
        return self._connections.get(connection_id)

    def get_default_connection(self) -> Optional[ConnectionConfig]:
        """
        Get the default connection.

        Returns:
            The default connection config or None if none set
        """
        for conn in self._connections.values():
            if conn.is_default:
                return conn

        # If no default, return the first one
        if self._connections:
            return next(iter(self._connections.values()))

        return None

    def list_connections(self, mask_secrets: bool = True) -> List[Dict]:
        """
        List all connections.

        Args:
            mask_secrets: If True, mask sensitive information

        Returns:
            List of connection configurations as dicts
        """
        return [
            conn.to_dict(mask_secrets=mask_secrets)
            for conn in self._connections.values()
        ]

    def get_provider(self, connection_id: str) -> Optional[StorageProvider]:
        """
        Get or create provider instance for connection.

        Args:
            connection_id: The ID of the connection

        Returns:
            The storage provider instance or None if connection not found
        """
        # Check if we have a cached provider
        if connection_id in self._providers:
            return self._providers[connection_id]

        # Get the connection config
        config = self.get_connection(connection_id)
        if not config:
            return None

        # Create the appropriate provider
        provider = self._create_provider(config)
        if provider:
            self._providers[connection_id] = provider

        return provider

    def get_default_provider(self) -> Optional[StorageProvider]:
        """
        Get the provider for the default connection.

        Returns:
            The storage provider for default connection or None
        """
        config = self.get_default_connection()
        if config:
            return self.get_provider(config.id)
        return None

    def _create_provider(self, config: ConnectionConfig) -> Optional[StorageProvider]:
        """
        Create a storage provider based on the config type.

        Args:
            config: The connection configuration

        Returns:
            A storage provider instance
        """
        if config.provider_type == ProviderType.S3:
            return S3Provider(config)

        # Future: Add GCS, Azure, etc.
        # elif config.provider_type == ProviderType.GCS:
        #     return GCSProvider(config)

        logger.warning(f"Unsupported provider type: {config.provider_type}")
        return None

    def test_connection(self, connection_id: str) -> bool:
        """
        Test if a connection is valid and accessible.

        Args:
            connection_id: The ID of the connection to test

        Returns:
            True if connection is valid, False otherwise
        """
        provider = self.get_provider(connection_id)
        if not provider:
            return False

        return provider.test_connection()

    def test_credentials(
        self,
        url: Optional[str],
        access_key: str,
        secret_key: str,
        region: Optional[str] = None,
        provider_type: ProviderType = ProviderType.S3,
    ) -> bool:
        """
        Test credentials without saving them.

        Args:
            url: Optional endpoint URL
            access_key: Access key
            secret_key: Secret key
            region: Optional region
            provider_type: The provider type

        Returns:
            True if credentials are valid
        """
        config = ConnectionConfig(
            id="test",
            name="Test Connection",
            provider_type=provider_type,
            url=url,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
        )

        provider = self._create_provider(config)
        if provider:
            return provider.test_connection()
        return False

    def connection_count(self) -> int:
        """Return the number of configured connections."""
        return len(self._connections)

    def has_connections(self) -> bool:
        """Return True if there are any configured connections."""
        return len(self._connections) > 0

    def invalidate_provider_cache(self, connection_id: Optional[str] = None) -> None:
        """
        Invalidate cached providers.

        Args:
            connection_id: Optional specific connection to invalidate.
                          If None, invalidates all providers.
        """
        if connection_id:
            self._providers.pop(connection_id, None)
        else:
            self._providers.clear()

    def set_default(self, connection_id: str) -> bool:
        """
        Set a connection as the default.

        Args:
            connection_id: The ID of the connection to set as default

        Returns:
            True if successful, False if connection not found
        """
        if connection_id not in self._connections:
            return False

        # Unset all defaults
        for conn in self._connections.values():
            conn.is_default = False

        # Set the new default
        self._connections[connection_id].is_default = True
        self._save_connections()
        return True
