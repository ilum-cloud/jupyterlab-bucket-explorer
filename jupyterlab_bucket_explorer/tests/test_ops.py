import base64

import boto3

from jupyterlab_bucket_explorer import handlers
from jupyterlab_bucket_explorer.handlers import (
    _test_s3_role_access,
    convertS3FStoJupyterFormat,
    create_s3_resource,
    get_s3_credentials,
    has_s3_role_access,
)


def _write_object(s3_resource, bucket, key, body):
    s3_resource.Object(bucket, key).put(Body=body)


def _make_config(url="", region="us-east-1"):
    config = get_s3_credentials()
    config.url = url
    config.region = region
    return config


def test_has_s3_role_access_false_without_config(monkeypatch):
    # Ensure config helper has no credentials
    monkeypatch.delenv("S3_ACCESS_KEY", raising=False)
    monkeypatch.delenv("S3_SECRET_KEY", raising=False)
    assert has_s3_role_access() is False


def test_role_access_lists_buckets(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-a")

    config = _make_config()
    result = _test_s3_role_access(config)

    assert {r["name"] for r in result} == {"bucket-a/"}


def test_test_s3_credentials_with_bucket(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-b")

    # Should not raise
    handlers.test_s3_credentials("", "testing", "testing", "us-east-1")


def test_list_objects_root_and_prefix(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-c")
    _write_object(s3_resource, "bucket-c", "folder/file.txt", b"hello")

    s3fs = handlers.create_s3fs(_make_config())
    root_listing = s3fs.listdir("")
    assert any(item["Key"] == "bucket-c" for item in root_listing)

    sub_listing = s3fs.listdir("bucket-c/folder/")
    names = {item["Key"] for item in sub_listing}
    assert "bucket-c/folder/file.txt" in names


def test_convert_s3fs_to_jupyter_format():
    payload = {"Key": "bucket-x/test.txt", "type": "file"}
    result = convertS3FStoJupyterFormat(payload, is_bucket=False)
    assert result["name"] == "test.txt"
    assert result["path"] == "bucket-x/test.txt"
    assert result["type"] == "file"
    assert result["mimetype"] is None


def test_read_file_content(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-d")
    _write_object(s3_resource, "bucket-d", "notes/readme.txt", b"hello")

    s3fs = handlers.create_s3fs(_make_config())
    with s3fs.open("bucket-d/notes/readme.txt", "rb") as f:
        content = f.read()

    assert content == b"hello"


def test_write_file_content(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-e")

    s3fs = handlers.create_s3fs(_make_config())
    with s3fs.open("bucket-e/upload.txt", "w") as f:
        f.write("data")

    body = s3_resource.Object("bucket-e", "upload.txt").get()["Body"].read()
    assert body == b"data"


def test_delete_object(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-f")
    _write_object(s3_resource, "bucket-f", "old.txt", b"bye")

    create_s3_resource(_make_config()).Object("bucket-f", "old.txt").delete()

    # Deleting is idempotent; confirm object is gone
    keys = [obj.key for obj in s3_resource.Bucket("bucket-f").objects.all()]
    assert "old.txt" not in keys


def test_read_binary_content_base64(moto_s3, s3_env):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-g")
    payload = b"\x00\x01\x02"
    _write_object(s3_resource, "bucket-g", "bin/data.bin", payload)

    s3fs = handlers.create_s3fs(_make_config())
    with s3fs.open("bucket-g/bin/data.bin", "rb") as f:
        encoded = base64.encodebytes(f.read()).decode("ascii")

    assert base64.b64decode(encoded) == payload
