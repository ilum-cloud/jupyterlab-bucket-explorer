import json

import boto3


async def _fetch_json(jp_fetch, *args, method="GET", headers=None, body=None):
    response = await jp_fetch(*args, method=method, headers=headers or {}, body=body)
    assert response.code == 200
    return json.loads(response.body)


async def test_auth_get_authenticated(s3_env, moto_s3, jp_fetch):
    boto3.resource("s3").create_bucket(Bucket="auth-bucket")

    payload = await _fetch_json(jp_fetch, "jupyterlab-bucket-explorer", "auth")
    assert payload == {"authenticated": True}


async def test_files_get_list_and_read(s3_env, moto_s3, jp_fetch):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-api")
    s3_resource.Object("bucket-api", "folder/readme.txt").put(Body=b"hello")

    listing = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-api",
        "folder/",
        method="GET",
        headers={"X-Storage-Is-Dir": "true"},
    )

    names = {item["name"] for item in listing}
    assert "readme.txt" in names

    content = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-api",
        "folder/readme.txt",
        method="GET",
    )

    assert content["type"] == "file"
    assert content["path"] == "bucket-api/folder/readme.txt"


async def test_files_put_upload_and_delete(s3_env, moto_s3, jp_fetch):
    boto3.resource("s3").create_bucket(Bucket="bucket-put")

    put_payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-put",
        "hello.txt",
        method="PUT",
        body=json.dumps({"content": "hello"}),
    )

    assert put_payload["path"] == "bucket-put/hello.txt"

    delete_payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-put",
        "hello.txt",
        method="DELETE",
    )

    assert delete_payload == {"success": True}


async def test_files_delete_dir_not_empty(s3_env, moto_s3, jp_fetch):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-dir")
    s3_resource.Object("bucket-dir", "dir/file.txt").put(Body=b"data")

    payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-dir",
        "dir",
        method="DELETE",
    )

    assert payload["error"] == "DIR_NOT_EMPTY"


async def test_files_put_directory_preserves_case(s3_env, moto_s3, jp_fetch):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-case")

    payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-case",
        "Reports/2024",
        method="PUT",
        headers={"X-Storage-Is-Dir": "true"},
        body=b"",
    )

    assert payload == {
        "path": "bucket-case/Reports/2024",
        "type": "directory",
        "success": True,
    }

    keys = {obj.key for obj in s3_resource.Bucket("bucket-case").objects.all()}
    assert "Reports/2024/.keep" in keys


async def test_upload_handler(s3_env, moto_s3, jp_fetch):
    boto3.resource("s3").create_bucket(Bucket="bucket-upload")
    body = (
        b"--boundary\r\n"
        b'Content-Disposition: form-data; name="file"; filename="notes.txt"\r\n'
        b"Content-Type: text/plain\r\n\r\n"
        b"hello\r\n"
        b"--boundary--\r\n"
    )

    payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "upload",
        "bucket-upload",
        "notes.txt",
        method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=boundary"},
        body=body,
    )

    assert payload["success"] is True


async def test_files_delete_dir_recursive(s3_env, moto_s3, jp_fetch):
    s3_resource = boto3.resource("s3")
    s3_resource.create_bucket(Bucket="bucket-recursive")
    # Create a nested structure
    s3_resource.Object("bucket-recursive", "parent/child/file.txt").put(Body=b"data")
    s3_resource.Object("bucket-recursive", "parent/sibling.txt").put(Body=b"data2")

    # Try recursive delete of 'parent'
    payload = await _fetch_json(
        jp_fetch,
        "jupyterlab-bucket-explorer",
        "files",
        "bucket-recursive",
        "parent",
        method="DELETE",
        headers={"X-Storage-Recursive": "true"},
    )

    assert payload == {"success": True}

    # Verify everything is gone
    bucket = s3_resource.Bucket("bucket-recursive")
    objects = list(bucket.objects.all())
    assert len(objects) == 0
