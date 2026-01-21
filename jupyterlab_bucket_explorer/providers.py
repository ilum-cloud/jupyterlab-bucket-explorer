"""
Abstract storage provider layer for multi-cloud support.

This module defines the abstract interface for cloud storage providers
and implements the S3-compatible provider.
"""

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

import boto3
import s3fs


class DirectoryNotEmptyException(Exception):
    """Exception raised when attempting to delete a non-empty directory."""

    pass


class ProviderType(Enum):
    """Supported cloud storage provider types."""

    S3 = "s3"
    # Future providers:
    # GCS = "gcs"
    # AZURE = "azure"
    # HDFS = "hdfs"


@dataclass
class ConnectionConfig:
    """Universal connection configuration for any storage provider."""

    id: str
    name: str
    provider_type: ProviderType
    url: Optional[str] = None
    access_key: Optional[str] = None
    secret_key: Optional[str] = None
    region: Optional[str] = None
    is_default: bool = False
    # Future extensibility for provider-specific config
    extra_config: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def generate_id(cls) -> str:
        """Generate a unique connection ID."""
        return str(uuid.uuid4())

    def to_dict(self, mask_secrets: bool = False) -> Dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "id": self.id,
            "name": self.name,
            "providerType": self.provider_type.value,
            "url": self.url or "",
            "accessKey": self.access_key or "",
            "region": self.region or "",
            "isDefault": self.is_default,
        }
        if mask_secrets:
            result["secretKey"] = "***" if self.secret_key else ""
        else:
            result["secretKey"] = self.secret_key or ""
        if self.extra_config:
            result["extraConfig"] = self.extra_config
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ConnectionConfig":
        """Create from dictionary."""
        provider_type = data.get("providerType") or data.get("provider_type", "s3")
        if isinstance(provider_type, str):
            provider_type = ProviderType(provider_type)

        return cls(
            id=data.get("id", cls.generate_id()),
            name=data.get("name", "Unnamed"),
            provider_type=provider_type,
            url=data.get("url"),
            access_key=data.get("accessKey") or data.get("access_key"),
            secret_key=data.get("secretKey") or data.get("secret_key"),
            region=data.get("region"),
            is_default=data.get("isDefault", False) or data.get("is_default", False),
            extra_config=data.get("extraConfig") or data.get("extra_config", {}),
        )


class StorageProvider(ABC):
    """
    Abstract base class for cloud storage providers.

    All concrete providers (S3, GCS, Azure, etc.) must implement this interface.
    """

    def __init__(self, config: ConnectionConfig):
        self.config = config

    @abstractmethod
    def list_buckets(self) -> List[Dict[str, Any]]:
        """List all buckets/containers in the storage."""
        pass

    @abstractmethod
    def list_objects(self, bucket: str, prefix: str = "") -> List[Dict[str, Any]]:
        """List objects in a bucket with optional prefix."""
        pass

    @abstractmethod
    def read_object(self, path: str) -> bytes:
        """Read object content as bytes."""
        pass

    @abstractmethod
    def write_object(self, path: str, content: bytes) -> None:
        """Write content to an object."""
        pass

    @abstractmethod
    def delete_object(self, path: str, recursive: bool = False) -> None:
        """Delete an object or directory."""
        pass



class S3Provider(StorageProvider):
    """
    S3-compatible storage provider implementation.

    Supports AWS S3, MinIO, and other S3-compatible storage services.
    """

    def __init__(self, config: ConnectionConfig):
        super().__init__(config)
        self._s3fs: Optional[s3fs.S3FileSystem] = None
        self._s3_resource = None

    def _create_s3fs(self) -> s3fs.S3FileSystem:
        """Create and return an s3fs instance."""
        if self.config.access_key and self.config.secret_key:
            client_kwargs = {}
            if self.config.url:
                client_kwargs["endpoint_url"] = self.config.url
            if self.config.region:
                client_kwargs["region_name"] = self.config.region

            return s3fs.S3FileSystem(
                key=self.config.access_key,
                secret=self.config.secret_key,
                client_kwargs=client_kwargs,
                use_listings_cache=False,
            )
        else:
            return s3fs.S3FileSystem(use_listings_cache=False)

    def _create_s3_resource(self):
        """Create and return a boto3 S3 resource."""
        if self.config.access_key and self.config.secret_key:
            kwargs = {
                "aws_access_key_id": self.config.access_key,
                "aws_secret_access_key": self.config.secret_key,
            }
            if self.config.url:
                kwargs["endpoint_url"] = self.config.url
            if self.config.region:
                kwargs["region_name"] = self.config.region

            return boto3.resource("s3", **kwargs)
        else:
            return boto3.resource("s3")

    def get_s3fs(self) -> s3fs.S3FileSystem:
        """Get or create the s3fs instance."""
        if self._s3fs is None:
            self._s3fs = self._create_s3fs()
        return self._s3fs

    def get_s3_resource(self):
        """Get or create the boto3 S3 resource."""
        if self._s3_resource is None:
            self._s3_resource = self._create_s3_resource()
        return self._s3_resource

    def invalidate_cache(self) -> None:
        """Invalidate the s3fs cache."""
        # Ensure we have the filesystem instance (may be shared/cached by fsspec).
        fs = self.get_s3fs()
        fs.invalidate_cache()

    def list_buckets(self) -> List[Dict[str, Any]]:
        """List all buckets."""
        s3_resource = self.get_s3_resource()
        return [
            {
                "name": bucket.name + "/",
                "path": bucket.name + "/",
                "type": "directory",
                "mimetype": "application/x-s3-bucket",
            }
            for bucket in s3_resource.buckets.all()
        ]

    def list_objects(self, bucket: str, prefix: str = "") -> List[Dict[str, Any]]:
        """List objects in bucket with prefix."""
        s3fs_instance = self.get_s3fs()
        s3fs_instance.invalidate_cache()

        path = f"{bucket}/{prefix}" if prefix else bucket
        raw_result = s3fs_instance.listdir(path)

        return [
            {
                "name": r["Key"].rsplit("/", 1)[-1],
                "path": r["Key"],
                "type": r["type"],
                "mimetype": None,
            }
            for r in raw_result
            if r["Key"].rsplit("/", 1)[-1] != ""
        ]

    def read_object(self, path: str) -> bytes:
        """Read object content."""
        s3fs_instance = self.get_s3fs()
        with s3fs_instance.open(path, "rb") as f:
            return f.read()


    def write_object(self, path: str, content: bytes) -> None:
        """Write content to object."""
        s3fs_instance = self.get_s3fs()
        mode = "wb" if isinstance(content, bytes) else "w"
        with s3fs_instance.open(path, mode) as f:
            f.write(content)

    def delete_object(self, path: str, recursive: bool = False) -> None:
        """Delete object or directory."""
        s3_resource = self.get_s3_resource()

        if "/" not in path:
            raise Exception("Cannot delete bucket root via this endpoint.")

        bucket_name, key = path.split("/", 1)
        bucket = s3_resource.Bucket(bucket_name)

        # Check if it's a directory by looking for objects with prefix key/
        sample_objects = list(bucket.objects.filter(Prefix=key + "/").limit(30))

        if len(sample_objects) > 0:
            # It is a directory (or has directory-like structure)

            # Check if it has children other than itself or ignored files
            children_found = False
            for obj in sample_objects:
                if obj.key == key or obj.key == key + "/":
                    continue
                if obj.key.endswith("/.keep"):
                    continue
                children_found = True
                break

            if children_found:
                if not recursive:
                    raise DirectoryNotEmptyException("DIR_NOT_EMPTY")
                else:
                    # Recursive delete - delete everything under key/
                    bucket.objects.filter(Prefix=key + "/").delete()
            else:
                # Empty directory (only contained placeholder key/ or .keep)
                bucket.objects.filter(Prefix=key + "/").delete()
        else:
            # No objects with prefix 'key/' found - it's a file
            s3_resource.Object(bucket_name, key).delete()

        self.invalidate_cache()

    def test_connection(self) -> bool:
        """Test if connection is valid by listing buckets."""
        try:
            self.list_buckets()
            return True
        except Exception:
            return False
