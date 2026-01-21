import pytest

pytest_plugins = ("pytest_jupyter.jupyter_server",)


@pytest.fixture(autouse=True)
def jupyter_dirs(monkeypatch, tmp_path_factory):
    base = tmp_path_factory.mktemp("jupyter")
    runtime_dir = base / "runtime"
    data_dir = base / "data"
    config_dir = base / "config"

    runtime_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
    config_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("JUPYTER_RUNTIME_DIR", str(runtime_dir))
    monkeypatch.setenv("JUPYTER_DATA_DIR", str(data_dir))
    monkeypatch.setenv("JUPYTER_CONFIG_DIR", str(config_dir))


@pytest.fixture
def jp_server_config(jp_server_config):
    return {"ServerApp": {"jpserver_extensions": {"jupyterlab_bucket_explorer": True}}}
