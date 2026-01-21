import io

import boto3
import pytest

try:
    from moto import mock_s3
except ImportError:  # pragma: no cover - fallback for newer moto versions
    # ruff: noqa: F821
    from moto import mock_aws as mock_s3


@pytest.fixture
def moto_s3():
    with mock_s3():
        yield


@pytest.fixture
def s3_env(monkeypatch, tmp_path):
    # Credentials for moto/boto3
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")

    # Credentials consumed by JupyterLabS3 config
    monkeypatch.setenv("S3_ACCESS_KEY", "testing")
    monkeypatch.setenv("S3_SECRET_KEY", "testing")
    monkeypatch.setenv("S3_ENDPOINT", "http://localhost")
    monkeypatch.setenv("S3_REGION", "us-east-1")

    # Isolate config helper from user machine
    from jupyterlab_bucket_explorer import handlers
    from jupyterlab_bucket_explorer.connection_manager import ConnectionManager
    from jupyterlab_bucket_explorer import providers

    handlers.s3_config_helper.config_path = tmp_path / "config.json"
    handlers.s3_config_helper.update_alias("", "testing", "testing", "us-east-1")

    class FakeS3FS:
        def __init__(self, alias_name=None, config_path=None):
            # Path to the S3/Client configuration file
            self.config_path = (
                Path(config_path)
                if config_path
                else Path(f"{Path.home()}/.mc/config.json")
            )
            self.alias_name = alias_name or "storage"

        def invalidate_cache(self):
            return None

        def _split_path(self, path):
            path = (path or "").lstrip("/")
            if not path or path == ".":
                return "", ""
            if "/" not in path:
                return path, ""
            return path.split("/", 1)

        def open(self, path, mode="rb"):
            bucket, key = self._split_path(path)
            if not bucket or not key:
                raise FileNotFoundError(path)

            if "r" in mode:
                body = self._s3.Object(bucket, key).get()["Body"].read()
                if "b" in mode:
                    return io.BytesIO(body)
                return io.StringIO(body.decode("utf-8"))

            return _S3WriteBuffer(self._s3, bucket, key, mode)

        def listdir(self, path):
            bucket, prefix = self._split_path(path)
            if not bucket:
                return [
                    {"Key": f"{b.name}", "type": "directory"}
                    for b in self._s3.buckets.all()
                ]

            if prefix and not prefix.endswith("/"):
                prefix = prefix + "/"

            results = []
            for obj in self._s3.Bucket(bucket).objects.filter(Prefix=prefix):
                key = f"{bucket}/{obj.key}"
                obj_type = "directory" if obj.key.endswith("/") else "file"
                results.append({"Key": key, "type": obj_type})
            return results

        def mkdir(self, path):
            bucket, key = self._split_path(path)
            if not bucket or not key:
                raise ValueError("Invalid path")
            if not key.endswith("/"):
                key = key + "/"
            self._s3.Object(bucket, key).put(Body=b"")

        def touch(self, path):
            bucket, key = self._split_path(path)
            if not bucket or not key:
                raise ValueError("Invalid path")
            self._s3.Object(bucket, key).put(Body=b"")

        def cp(self, source, path, recursive=True):
            src_bucket, src_key = self._split_path(source)
            dst_bucket, dst_key = self._split_path(path)
            body = self._s3.Object(src_bucket, src_key).get()["Body"].read()
            self._s3.Object(dst_bucket, dst_key).put(Body=body)

        def move(self, source, path, recursive=True):
            self.cp(source, path, recursive=recursive)
            src_bucket, src_key = self._split_path(source)
            self._s3.Object(src_bucket, src_key).delete()

    class _S3WriteBuffer:
        def __init__(self, s3_resource, bucket, key, mode):
            self._s3 = s3_resource
            self._bucket = bucket
            self._key = key
            self._mode = mode
            self._buffer = io.BytesIO() if "b" in mode else io.StringIO()

        def write(self, data):
            return self._buffer.write(data)

        def __enter__(self):
            return self

        # Mock S3FileSystem that uses boto3 directly to avoid aiobotocore/moto issues

    class MockS3FileSystem:
        def __init__(self, *args, **kwargs):
            self.s3 = boto3.client("s3", region_name="us-east-1")

        def invalidate_cache(self, path=None):
            pass

        def exists(self, path):
            bucket, key = path.split("/", 1) if "/" in path else (path, "")
            if not key:
                # Check if bucket exists
                try:
                    self.s3.head_bucket(Bucket=bucket)
                    return True
                except Exception:
                    return False
            try:
                self.s3.head_object(Bucket=bucket, Key=key)
                return True
            except Exception:
                # Check if it is a directory (prefix)
                try:
                    res = self.s3.list_objects_v2(
                        Bucket=bucket, Prefix=key + "/", MaxKeys=1
                    )
                    return "Contents" in res or "CommonPrefixes" in res
                except Exception:
                    return False

        def isdir(self, path):
            bucket, key = path.split("/", 1) if "/" in path else (path, "")
            if not key:
                return True
            if key.endswith("/"):
                return True
            res = self.s3.list_objects_v2(Bucket=bucket, Prefix=key + "/", MaxKeys=1)
            return "Contents" in res or "CommonPrefixes" in res

        def ls(self, path, detail=False):
            res = self.listdir(path)
            if detail:
                return res
            return [r["Key"] for r in res]

        def open(self, path, mode="rb"):
            import io

            bucket, key = path.split("/", 1)

            if "w" in mode:
                # Mock file writer
                class S3Writer(io.BytesIO):
                    def __init__(self, s3_client, bucket, key):
                        super().__init__()
                        self.s3_client = s3_client
                        self.bucket = bucket
                        self.key = key

                    def write(self, b):
                        if isinstance(b, str):
                            b = b.encode("utf-8")
                        return super().write(b)

                    def close(self):
                        self.seek(0)
                        self.s3_client.put_object(
                            Bucket=self.bucket,
                            Key=self.key,
                            Body=self.read(),
                        )

                return S3Writer(self.s3, bucket, key)
            else:
                # Mock file reader
                try:
                    obj = self.s3.get_object(Bucket=bucket, Key=key)
                    return io.BytesIO(obj["Body"].read())
                except Exception as e:
                    raise FileNotFoundError(path) from e

        def listdir(self, path):
            if not path:
                # List buckets
                return [
                    {"Key": b["Name"], "type": "directory"}
                    for b in self.s3.list_buckets().get("Buckets", [])
                ]

            # List objects
            bucket, _, prefix = path.partition("/")
            paginator = self.s3.get_paginator("list_objects_v2")
            results = []

            prefix = prefix if prefix != "" else ""

            # Standardize prefix for dir matching
            if prefix and not prefix.endswith("/"):
                prefix += "/"

            for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
                # Directories (CommonPrefixes)
                for p in page.get("CommonPrefixes", []):
                    results.append(
                        {
                            "Key": bucket + "/" + p["Prefix"],
                            "type": "directory",
                            "name": p["Prefix"].strip("/"),
                            "Size": 0,
                        }
                    )

                # Files
                for c in page.get("Contents", []):
                    if c["Key"] == prefix:
                        continue  # Skip self
                    results.append(
                        {
                            "Key": bucket + "/" + c["Key"],
                            "Size": c.get("Size", 0),
                            "type": "file",
                            "LastModified": c.get("LastModified"),
                            "name": c["Key"].split("/")[-1],
                        }
                    )
            return results

        def info(self, path):
            bucket, key = path.split("/", 1)
            try:
                obj = self.s3.head_object(Bucket=bucket, Key=key)
                return {"Key": path, "Size": obj["ContentLength"], "type": "file"}
            except Exception:
                # Check if it is a directory (prefix) via list
                if self.listdir(path):
                    return {"Key": path, "type": "directory"}
                raise FileNotFoundError(path) from None

        def mkdir(self, path):
            bucket, key = path.split("/", 1)
            if not key.endswith("/"):
                key += "/"
            self.s3.put_object(Bucket=bucket, Key=key, Body=b"")

        def touch(self, path):
            bucket, key = path.split("/", 1)
            self.s3.put_object(Bucket=bucket, Key=key, Body=b"")

        def rm(self, path, recursive=False):
            bucket, key = path.split("/", 1)
            if recursive:
                # flawed but sufficient for our specific test case
                objects = self.s3.list_objects_v2(Bucket=bucket, Prefix=key)
                if "Contents" in objects:
                    delete_keys = [{"Key": o["Key"]} for o in objects["Contents"]]
                    self.s3.delete_objects(
                        Bucket=bucket, Delete={"Objects": delete_keys}
                    )
            else:
                self.s3.delete_object(Bucket=bucket, Key=key)

        def cp(self, src, dst, **kwargs):
            # Used in move/copy
            src_bucket, src_key = src.split("/", 1)
            dst_bucket, dst_key = dst.split("/", 1)
            self.s3.copy_object(
                CopySource={"Bucket": src_bucket, "Key": src_key},
                Bucket=dst_bucket,
                Key=dst_key,
            )

    def _create_s3fs_mock(config):
        return MockS3FileSystem()

    monkeypatch.setattr(providers.S3Provider, "_create_s3fs", lambda self: MockS3FileSystem())
    monkeypatch.setattr(
        providers.S3Provider,
        "_create_s3_resource",
        lambda self: boto3.resource("s3", region_name="us-east-1"),
    )
    monkeypatch.setattr(handlers, "create_s3fs", _create_s3fs_mock)
    handlers.connection_manager = ConnectionManager(
        config_path=tmp_path / "connections.json"
    )
    yield
