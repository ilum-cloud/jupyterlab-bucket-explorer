import boto3

from jupyterlab_bucket_explorer import handlers


def test_has_s3_role_access_returns_false_without_config(monkeypatch):
    monkeypatch.delenv("S3_ACCESS_KEY", raising=False)
    monkeypatch.delenv("S3_SECRET_KEY", raising=False)
    assert handlers.has_s3_role_access() is False


def test_get_s3_credentials_returns_config(s3_env):
    config = handlers.get_s3_credentials()
    assert config.accessKey == "testing"
    assert config.secretKey == "testing"
    assert config.region == "us-east-1"


def test_test_s3_credentials_raises_on_invalid(moto_s3, s3_env, monkeypatch):
    def _raise(*args, **kwargs):
        raise Exception("bad creds")

    monkeypatch.setattr(boto3, "resource", _raise)

    try:
        handlers.test_s3_credentials("", "bad", "bad")
    except Exception as exc:
        assert "bad creds" in str(exc)
    else:
        raise AssertionError("Expected exception")
