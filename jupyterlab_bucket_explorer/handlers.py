import base64
import json
import logging
import re

import boto3
import colorlog
import s3fs
import tornado
from botocore.exceptions import NoCredentialsError
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

from ._version import __version__ as __version__
from .connection_manager import ConnectionManager
from .providers import ConnectionConfig, DirectoryNotEmptyException, ProviderType
from .utils import EnvironmentManager, S3ConfigHelper

########################### Custom logging
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class CustomFormatter(colorlog.ColoredFormatter):
    def format(self, record):
        # Add the class name to the record dynamically
        record.classname = (
            record.args.get("classname", record.name)
            if isinstance(record.args, dict)
            else "NoClass"
        )
        return super().format(record)


handler = colorlog.StreamHandler()
handler.setFormatter(
    CustomFormatter(
        "%(log_color)s[%(levelname).1s %(asctime)s %(classname)s] %(message)s",
        log_colors={
            "DEBUG": "cyan",
            "INFO": "green",
            "WARNING": "yellow",
            "ERROR": "red",
            "CRITICAL": "bold_red",
        },
    )
)

logger.addHandler(handler)

########################### Custom helpers

s3_config_helper = S3ConfigHelper()
# bash_helper = BashrcEnvManager()
env_manager = EnvironmentManager()

# Global connection manager instance
connection_manager = ConnectionManager()


########################### Custom exceptions


class S3ResourceNotFoundException(Exception):
    pass


########################### Custom methods


def create_s3fs(config):
    if config.accessKey and config.secretKey:
        client_kwargs = {}
        if config.url:
            client_kwargs["endpoint_url"] = config.url
        if config.region:
            client_kwargs["region_name"] = config.region

        return s3fs.S3FileSystem(
            key=config.accessKey,
            secret=config.secretKey,
            client_kwargs=client_kwargs,
        )
    else:
        return s3fs.S3FileSystem()


def create_s3_resource(config):
    if config.accessKey and config.secretKey:
        kwargs = {
            "aws_access_key_id": config.accessKey,
            "aws_secret_access_key": config.secretKey,
        }
        if config.url:
            kwargs["endpoint_url"] = config.url
        if config.region:
            kwargs["region_name"] = config.region

        return boto3.resource("s3", **kwargs)

    else:
        return boto3.resource("s3")


def get_s3_credentials():
    """
    Load S3 credential from configuration file
    """
    if s3_config_helper.exist:
        return s3_config_helper.config
    return None


def _test_s3_role_access(config):
    """
    Checks if we have access to s3 bucket through role-based access
    """
    kwargs = {
        "aws_access_key_id": config.accessKey,
        "aws_secret_access_key": config.secretKey,
    }
    if config.url:
        kwargs["endpoint_url"] = config.url
    if config.region:
        kwargs["region_name"] = config.region

    test = boto3.resource("s3", **kwargs)
    all_buckets = test.buckets.all()
    result = [
        {"name": bucket.name + "/", "path": bucket.name + "/", "type": "directory"}
        for bucket in all_buckets
    ]
    return result


def has_s3_role_access():
    # ruff: noqa: F821
    """
    Returns true if the user has access to an s3 bucket
    """

    # avoid making requests to S3 if the user's ~/.mc/config.json file has
    # credentials for a different provider, e.g.
    # https://cloud.ibm.com/docs/cloud-object-storage?topic=cloud-object-storage-aws-cli#aws-cli-config

    config = get_s3_credentials()
    if not config:
        return False

    try:
        _test_s3_role_access(config)
        return True
    except NoCredentialsError:
        return False
    except Exception as e:
        logger.error(e)
        return False


def test_s3_credentials(url, accessKey, secretKey, region=""):
    """
    Checks if we're able to list buckets with these credentials.
    If not, it throws an exception.
    """
    kwargs = {
        "aws_access_key_id": accessKey,
        "aws_secret_access_key": secretKey,
    }
    if url:
        kwargs["endpoint_url"] = url
    if region:
        kwargs["region_name"] = region

    test = boto3.resource("s3", **kwargs)
    all_buckets = test.buckets.all()
    logger.debug(
        [
            {"name": bucket.name + "/", "path": bucket.name + "/", "type": "directory"}
            for bucket in all_buckets
        ]
    )


# Standalone normalization function
def normalize_s3_path(path: str) -> str:
    if not path:
        return ""

    logger.debug(f"Normalizing path input: '{path}'")

    # Explicitly handle S3:// or s3:// prefix (case-insensitive)
    if path.upper().startswith("S3://"):
        path = path[5:]  # Remove full "S3://" (5 chars)
    elif path.startswith("S3:"):
        path = path[3:]  # Remove just "S3:" for legacy paths

    normalized = path.strip()
    if normalized in (".", "/"):
        return ""

    if normalized.startswith("/"):
        normalized = normalized.lstrip("/")

    drive_match = re.match(r"^[A-Za-z0-9_-]+:", normalized)
    if drive_match:
        normalized = normalized[drive_match.end() :]

    normalized = normalized.lstrip("/")

    if normalized in ("", ".", "/"):
        return ""

    logger.debug(f"Normalizing path output: '{normalized}'")
    return normalized


def convertS3FStoJupyterFormat(result, is_bucket=False):
    key = result["Key"]
    if key.endswith("/") and len(key) > 1:
        key = key[:-1]

    return {
        "name": key.rsplit("/", 1)[-1],
        "path": result["Key"],
        "type": result["type"],
        "mimetype": "application/x-s3-bucket" if is_bucket else None,
    }


########################### Custom class
class CustomAPIHandler(APIHandler):
    """
    Read S3 credential from config
    """

    @property
    def config(self):
        credentials = get_s3_credentials()
        if credentials:
            return credentials
        return self.settings["s3_config"]

    def _normalize_s3_path(self, path: str) -> str:
        return normalize_s3_path(path)


class HealthRouteHandler(APIHandler):  # pylint: disable=abstract-method
    """Lightweight endpoint for smoke tests."""

    @tornado.web.authenticated
    def get(self, path=""):
        self.finish(json.dumps({"status": "ok"}))


class AuthRouteHandler(APIHandler):
    """Handler to check authentication status."""

    @tornado.web.authenticated
    def get(self, path=""):
        self.finish(json.dumps({"authenticated": True}))


class S3PathRouteHandler(CustomAPIHandler):
    """
    Handles requests for getting S3 objects.

    Supports multi-connection via X-Connection-Id header.
    Falls back to default connection if header not provided.
    """

    def _get_provider(self):
        """Get the storage provider for this request."""
        # 1. Stateless / Header-based Auth (Settings Registry)
        if "X-S3-Access-Key" in self.request.headers:

            from .providers import ConnectionConfig, ProviderType, S3Provider

            # Create ephemeral config from headers
            config = ConnectionConfig(
                id="ephemeral",
                name="ephemeral",
                provider_type=ProviderType.S3,
                url=self.request.headers.get("X-S3-Endpoint", ""),
                access_key=self.request.headers.get("X-S3-Access-Key"),
                secret_key=self.request.headers.get("X-S3-Secret-Key"),
                region=self.request.headers.get("X-S3-Region", ""),
            )
            return S3Provider(config)

        # 2. Connection ID (Legacy / Database)
        connection_id = self.request.headers.get("X-Connection-Id", "default")

        # Try to get provider from connection manager
        provider = connection_manager.get_provider(connection_id)
        if provider:
            return provider

        # Fallback to default provider
        provider = connection_manager.get_default_provider()
        if provider:
            return provider

        # Last resort: use legacy config
        return None

    def _get_filesystem(self):
        """Get filesystem instance for this request."""
        provider = self._get_provider()
        if not provider:
            raise Exception("No storage provider configured")
        provider.invalidate_cache()
        return provider.get_s3fs()

    def _get_resource(self):
        """Get storage resource for this request."""
        provider = self._get_provider()
        if not provider:
            raise Exception("No storage provider configured")
        return provider.get_s3_resource()

    @tornado.web.authenticated
    def get(self, path=""):
        """
        Takes a path and returns lists of files/objects
        and directories/prefixes based on the path.
        """
        path = self._normalize_s3_path(path[1:])

        try:
            s3fs_instance = self._get_filesystem()

            if (path and not path.endswith("/")) and (
                "X-Storage-Is-Dir" not in self.request.headers
            ):  # TODO: replace with function
                with s3fs_instance.open(path, "rb") as f:
                    result = {
                        "path": path,
                        "type": "file",
                        "content": base64.encodebytes(f.read()).decode("ascii"),
                    }
            else:
                is_root = not path or path == "."
                raw_result = [
                    convertS3FStoJupyterFormat(r, is_bucket=is_root)
                    for r in s3fs_instance.listdir(path)
                ]

                # Filter out empty names
                filtered_result = list(filter(lambda x: x["name"] != "", raw_result))

                # Apply max items limit query param if present
                limit = self.get_query_argument("limit", default=None)
                if limit:
                    try:
                        limit_int = int(limit)
                        result = filtered_result[:limit_int]
                    except ValueError:
                        result = filtered_result
                else:
                    # Optional hard default or pass through
                    result = filtered_result

        except S3ResourceNotFoundException:
            result = {
                "error": 404,
                "message": "The requested resource could not be found.",
            }
        except Exception as e:
            logger.error(
                f"Exception encountered while reading S3 resources {path}: {e}"
            )
            result = {"error": 500, "message": str(e)}

        self.finish(json.dumps(result))

    @tornado.web.authenticated
    def put(self, path=""):
        """
        Takes a path and returns lists of files/objects
        and directories/prefixes based on the path.
        """
        path = self._normalize_s3_path(path[1:])

        result = {}

        try:
            s3fs_instance = self._get_filesystem()

            if "X-Storage-Copy-Src" in self.request.headers:
                source = self._normalize_s3_path(
                    self.request.headers["X-Storage-Copy-Src"]
                )

                s3fs_instance.invalidate_cache()
                
                # Check if source is directory BEFORE operation to ensure correct handling
                # We check both the raw path and with trailing slash to be safe
                source_is_dir = s3fs_instance.isdir(source) or s3fs_instance.isdir(source + "/")
                
                logger.info(f"COPY request: source={source}, dest={path}, source_is_dir={source_is_dir}")
                
                if source_is_dir:
                    # Enforce trailing slashes for directory operations
                    if not source.endswith("/"):
                        source += "/"
                    if not path.endswith("/"):
                        path += "/"
                    item_type = "directory"
                else:
                    item_type = "file"
                
                # Use custom recursive copy logic to handle empty directories (Delta Tables)
                self._recursive_copy_or_move(s3fs_instance, source, path, is_move=False)
                
                s3fs_instance.invalidate_cache()
                
                # Double check existence/type if it was a file, but trust source logic for dirs
                if not source_is_dir:
                     if s3fs_instance.isdir(path):
                        item_type = "directory"

                logger.info(f"COPY success. Returning type: {item_type}")
                result = {"path": path.rstrip("/"), "type": item_type, "success": True}

            elif "X-Storage-Move-Src" in self.request.headers:
                source = self._normalize_s3_path(
                    self.request.headers["X-Storage-Move-Src"]
                )

                s3fs_instance.invalidate_cache()
                source_is_dir = s3fs_instance.isdir(source) or s3fs_instance.isdir(source + "/")
                
                logger.info(f"MOVE request: source={source}, dest={path}, source_is_dir={source_is_dir}")
                
                if source_is_dir:
                    if not source.endswith("/"):
                        source += "/"
                    if not path.endswith("/"):
                        path += "/"
                    item_type = "directory"
                else:
                    item_type = "file"
                    
                # Use custom recursive move logic
                self._recursive_copy_or_move(s3fs_instance, source, path, is_move=True)
                
                s3fs_instance.invalidate_cache()
                
                if not source_is_dir and s3fs_instance.isdir(path):
                    item_type = "directory"

                logger.info(f"MOVE success. Returning type: {item_type}")
                result = {"path": path.rstrip("/"), "type": item_type, "success": True}



            elif "X-Storage-Is-Dir" in self.request.headers:
                if not path:
                    raise Exception("Cannot create a directory at the root.")
                
                # Create directory marker using .keep file (fs.mkdirs is no-op in MinIO)
                logger.info(f"Creating directory: {path}")
                if not path.endswith("/"):
                    path += "/"
                keep_path = path.rstrip('/') + '/.keep'
                s3fs_instance.touch(keep_path)
                s3fs_instance.invalidate_cache()
                
                result = {"path": path.rstrip("/"), "type": "directory", "success": True}

            else:
                # Regular file write (save/create)
                # Frontend sends: { content: "..." }
                s3fs_instance.invalidate_cache()
                
                if not path:
                    raise Exception("Path is required for file write.")
                
                try:
                    req = json.loads(self.request.body) if self.request.body else {}
                    content = req.get("content", "")
                    
                    logger.info(f"Writing file: {path}, content length: {len(content)}")
                    
                    # Write content to S3
                    with s3fs_instance.open(path, "w") as f:
                        f.write(content)
                    
                    s3fs_instance.invalidate_cache()
                    result = {"path": path, "type": "file", "success": True}
                    
                except json.JSONDecodeError:
                    # If body is not JSON, treat as empty file creation
                    logger.warning(f"Non-JSON body for {path}, creating empty file")
                    with s3fs_instance.open(path, "w") as f:
                        f.write("")
                    s3fs_instance.invalidate_cache()
                    result = {"path": path, "type": "file", "success": True}

        except Exception as e:
            # Clean up error handling
            raise e

        self.finish(json.dumps(result))

    @tornado.web.authenticated
    def delete(self, path=""):
        """
        Takes a path and returns lists of files/objects
        and directories/prefixes based on the path.
        """
        path = self._normalize_s3_path(path[1:])
        #  logger.info("DELETE: {}".format(path))

        result = {}

        try:
            s3fs_instance = self._get_filesystem()

            # Check if recursive delete is requested
            recursive_header = self.request.headers.get(
                "X-Storage-Recursive", "false"
            )
            recursive_arg = self.get_query_argument("recursive", "false")
            recursive = recursive_header.lower() in (
                "true",
                "1",
            ) or recursive_arg.lower() in ("true", "1")

            logger.info(f"DELETE request: path={path}, recursive={recursive}")

            # CRITICAL: Prevent deleting buckets (root items in s3fs)
            if "/" not in path:
                raise Exception("Bucket deletion is not currently supported.")

            provider = self._get_provider()
            if provider:
                # Use provider implementation if available
                provider.delete_object(path, recursive=recursive)
                self.finish(json.dumps({"success": True}))
                return

            if not s3fs_instance.exists(path):
                raise S3ResourceNotFoundException(f"Path {path} not found")

            # Check if directory
            if s3fs_instance.isdir(path):
                # It is a directory

                # Check contents if not recursive
                if not recursive:
                    # List contents to check if empty (ignoring self and .keep)
                    try:
                        contents = s3fs_instance.ls(path, detail=False)
                        # Filter out the directory itself and .keep files
                        real_contents = []
                        for c in contents:
                            c_clean = c.rstrip("/")
                            path_clean = path.rstrip("/")
                            if c_clean == path_clean:
                                continue
                            if c.endswith(".keep"):
                                continue
                            real_contents.append(c)

                        if len(real_contents) > 0:
                            raise DirectoryNotEmptyException("DIR_NOT_EMPTY")
                    except FileNotFoundError:
                        # Should not happen given exists check, but safety
                        pass

                # Delete directory (recursive=True handles .keep and contents)
                s3fs_instance.rm(path, recursive=True)

            else:
                # File delete
                s3fs_instance.rm(path)

            # Return explicit success JSON
            self.finish(json.dumps({"success": True}))

        except S3ResourceNotFoundException as e:
            logger.error(e)
            result = {
                "error": 404,
                "message": "The requested resource could not be found.",
            }
        except FileNotFoundError:
            result = {
                "error": 404,
                "message": "The requested resource could not be found.",
            }
        except DirectoryNotEmptyException:
            # Consistent with what frontend expects
            result = {"error": "DIR_NOT_EMPTY", "message": "DIR_NOT_EMPTY"}
        except Exception as e:
            logger.error("error while deleting")
            logger.error(e)
            result = {"error": 500, "message": str(e)}

        if result:
            self.finish(json.dumps(result))

    def _recursive_copy_or_move(self, fs, source, dest, is_move=False):
        """
        Custom recursive function to handle empty directories correctly.
        s3fs.cp(recursive=True) often skips empty folders.
        """
        if not source.endswith("/"):
            # Single file case
            if is_move:
                fs.move(source, dest)
            else:
                fs.cp(source, dest)
            return

        # Recursive case (Directory)
        # 1. Find all objects (files AND directories)
        source = source.strip("/")
        dest = dest.strip("/")
        try:
            all_objects = fs.find(source, detail=True)
        except Exception:
            # Fallback for empty/single dir
            all_objects = {}
        
        # If source is empty but exists as a directory marker
        if not all_objects and (fs.isdir(source) or fs.isdir(source + "/")):
             logger.info(f"Source {source} is empty directory. Creating dest {dest}")
             # fs.mkdirs() is a no-op in s3fs/MinIO - use touch to create a .keep file
             keep_path = dest.rstrip('/') + '/.keep'
             fs.touch(keep_path)
             if is_move:
                 fs.rm(source, recursive=True)
             return

        for src_path, info in all_objects.items():
            # Calculate destination path
            # src_path: bucket/folder/subfolder/file
            # source:   bucket/folder
            # dest:     bucket/dest_folder
            # rel_path: subfolder/file
            rel_path = src_path[len(source):].lstrip("/")
            dst_path = f"{dest}/{rel_path}"
            
            # Fix for misclassified directory markers (type='file' but ends with /)
            if info["type"] == "directory" or src_path.endswith("/"):
                # fs.mkdirs() is a no-op in s3fs/MinIO - use touch to create a .keep file
                logger.info(f"Creating directory via .keep: {dst_path}")
                keep_path = dst_path.rstrip('/') + '/.keep'
                fs.touch(keep_path)
            else:
                # Copy file
                logger.debug(f"Copying file: {src_path} -> {dst_path}")
                fs.cp(src_path, dst_path)

        if is_move:
            # Delete source after copy
            # We use recursive=True to clean up everything
            fs.rm(source, recursive=True)


class UploadHandler(CustomAPIHandler):
    """
    Handles binary file uploads via multipart/form-data.

    Supports multi-connection via X-Connection-Id header.
    """

    def _get_provider(self):
        """Get the storage provider for this request."""
        # 1. Stateless / Header-based Auth (Settings Registry)
        if "X-S3-Access-Key" in self.request.headers:
            from .providers import ConnectionConfig, ProviderType, S3Provider

            # Create ephemeral config from headers
            config = ConnectionConfig(
                id="ephemeral",
                name="ephemeral",
                provider_type=ProviderType.S3,
                url=self.request.headers.get("X-S3-Endpoint", ""),
                access_key=self.request.headers.get("X-S3-Access-Key"),
                secret_key=self.request.headers.get("X-S3-Secret-Key"),
                region=self.request.headers.get("X-S3-Region", ""),
            )
            return S3Provider(config)

        # 2. Legacy / Connection ID
        connection_id = self.request.headers.get("X-Connection-Id", "default")

        provider = connection_manager.get_provider(connection_id)
        if provider:
            return provider

        return connection_manager.get_default_provider()

    def _get_filesystem(self):
        """Get filesystem instance for this request."""
        provider = self._get_provider()
        if not provider:
            raise Exception("No storage provider configured")
        provider.invalidate_cache()
        return provider.get_s3fs()

    @tornado.web.authenticated
    def post(self, path=""):
        """
        Upload a file to S3 using multipart/form-data.
        Path is provided as URL parameter.
        File is provided in the request body.
        """
        path = self._normalize_s3_path(path[1:])  # Remove leading slash

        result = {}

        try:
            if not path:
                raise Exception("Upload path is required.")
            s3fs_instance = self._get_filesystem()

            # Get the uploaded file from the request
            file_info = self.request.files.get("file")
            if not file_info:
                raise Exception("No file provided in request")

            file_data = file_info[0]
            file_body = file_data["body"]

            # Write the file to S3 in binary mode
            with s3fs_instance.open(path, "wb") as f:
                f.write(file_body)

            result = {"success": True, "path": path, "type": "file"}

        except Exception as e:
            logger.error(f"Upload error for {path}: {e}")
            result = {"error": 500, "message": str(e)}

        self.finish(json.dumps(result))


########################### Connection Management Handler
class ConnectionRouteHandler(APIHandler):
    """
    Handle CRUD operations for storage connections.

    Endpoints:
    - GET /connections - List all connections
    - GET /connections/<id> - Get specific connection
    - POST /connections - Create new connection
    - PUT /connections/<id> - Update connection
    - DELETE /connections/<id> - Remove connection
    - POST /connections/<id>/test - Test connection
    - POST /connections/<id>/default - Set as default
    """

    @tornado.web.authenticated
    def get(self, path=""):
        """List all connections or get specific connection."""
        path = path.strip("/")

        try:
            if path:
                # Get specific connection
                conn = connection_manager.get_connection(path)
                if conn:
                    self.finish(json.dumps(conn.to_dict(mask_secrets=True)))
                else:
                    self.finish(
                        json.dumps(
                            {"error": 404, "message": f"Connection '{path}' not found"}
                        )
                    )
            else:
                # List all connections
                mask_param = self.get_query_argument("mask", "true").lower()
                should_mask = mask_param not in ("false", "0", "no")

                connections = connection_manager.list_connections(
                    mask_secrets=should_mask
                )
                self.finish(
                    json.dumps({"connections": connections, "count": len(connections)})
                )
        except Exception as e:
            logger.error(f"Error in GET /connections: {e}")
            self.finish(json.dumps({"error": 500, "message": str(e)}))

    @tornado.web.authenticated
    def post(self, path=""):
        """Create new connection or perform actions."""
        path = path.strip("/")

        try:
            req = json.loads(self.request.body)

            # Handle special actions
            if path == "test":
                # Test credentials without saving
                url = req.get("url")
                access_key = req.get("accessKey")
                secret_key = req.get("secretKey")
                region = req.get("region")
                connection_id = req.get("connectionId")

                # Fallback to existing connection secret if missing and ID provided
                if not secret_key and connection_id:
                    existing = connection_manager.get_connection(connection_id)
                    if existing:
                        secret_key = existing.secret_key

                success = connection_manager.test_credentials(
                    url=url,
                    access_key=access_key,
                    secret_key=secret_key,
                    region=region,
                )

                self.finish(json.dumps({"success": success}))
                return

            if path.endswith("/test"):
                # Test existing connection
                conn_id = path.replace("/test", "")
                success = connection_manager.test_connection(conn_id)
                self.finish(json.dumps({"success": success}))
                return

            if path.endswith("/default"):
                # Set as default connection
                conn_id = path.replace("/default", "")
                success = connection_manager.set_default(conn_id)
                self.finish(json.dumps({"success": success}))
                return

            # Create new connection
            config = ConnectionConfig(
                id=ConnectionConfig.generate_id(),
                name=req.get("name", "Unnamed Connection"),
                provider_type=ProviderType(req.get("providerType", "s3")),
                url=req.get("url"),
                access_key=req.get("accessKey"),
                secret_key=req.get("secretKey"),
                region=req.get("region"),
                is_default=req.get("isDefault", False),
            )

            # Test connection before saving
            if not connection_manager.test_credentials(
                config.url, config.access_key, config.secret_key, config.region
            ):
                self.finish(
                    json.dumps(
                        {
                            "success": False,
                            "message": "Failed to connect with provided credentials",
                        }
                    )
                )
                return

            connection_id = connection_manager.add_connection(config)
            self.finish(
                json.dumps(
                    {
                        "success": True,
                        "id": connection_id,
                        "connection": config.to_dict(mask_secrets=True),
                    }
                )
            )

        except Exception as e:
            logger.error(f"Error in POST /connections: {e}")
            self.finish(json.dumps({"success": False, "message": str(e)}))

    @tornado.web.authenticated
    def put(self, path=""):
        """Update existing connection."""
        path = path.strip("/")

        try:
            req = json.loads(self.request.body)

            # Get existing connection
            existing = connection_manager.get_connection(path)
            if not existing:
                self.finish(
                    json.dumps(
                        {"error": 404, "message": f"Connection '{path}' not found"}
                    )
                )
                return

            # Update fields
            config = ConnectionConfig(
                id=path,
                name=req.get("name", existing.name),
                provider_type=existing.provider_type,
                url=req.get("url", existing.url),
                access_key=req.get("accessKey", existing.access_key),
                secret_key=req.get("secretKey", existing.secret_key),
                region=req.get("region", existing.region),
                is_default=req.get("isDefault", existing.is_default),
            )

            connection_manager.add_connection(config)
            self.finish(
                json.dumps(
                    {"success": True, "connection": config.to_dict(mask_secrets=True)}
                )
            )

        except Exception as e:
            logger.error(f"Error in PUT /connections: {e}")
            self.finish(json.dumps({"success": False, "message": str(e)}))

    @tornado.web.authenticated
    def delete(self, path=""):
        """Remove connection."""
        path = path.strip("/")

        try:
            if not path:
                self.finish(
                    json.dumps({"error": 400, "message": "Connection ID required"})
                )
                return

            success = connection_manager.remove_connection(path)
            if success:
                self.finish(json.dumps({"success": True}))
            else:
                self.finish(
                    json.dumps(
                        {"error": 404, "message": f"Connection '{path}' not found"}
                    )
                )

        except Exception as e:
            logger.error(f"Error in DELETE /connections: {e}")
            self.finish(json.dumps({"success": False, "message": str(e)}))


########################### Setup lab handler
def setup_handlers(web_app):
    host_pattern = ".*"

    base_url = web_app.settings["base_url"]
    handlers = [
        (
            url_path_join(base_url, "jupyterlab-bucket-explorer", "health(.*)"),
            HealthRouteHandler,
        ),
        (
            url_path_join(base_url, "jupyterlab-bucket-explorer", "auth(.*)"),
            AuthRouteHandler,
        ),
        (
            url_path_join(base_url, "jupyterlab-bucket-explorer", "files(.*)"),
            S3PathRouteHandler,
        ),
        (
            url_path_join(base_url, "jupyterlab-bucket-explorer", "upload(.*)"),
            UploadHandler,
        ),
        (
            url_path_join(base_url, "jupyterlab-bucket-explorer", "connections(.*)"),
            ConnectionRouteHandler,
        ),
    ]
    web_app.add_handlers(host_pattern, handlers)
