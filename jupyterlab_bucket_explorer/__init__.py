from ._version import __version__ as __version__
from .handlers import setup_handlers
from .utils import JupyterLabS3

__all__ = ["__version__", "setup_handlers", "JupyterLabS3"]


def _jupyter_labextension_paths():
    return [{"src": "labextension", "dest": "jupyterlab-bucket-explorer"}]


def _jupyter_server_extension_points():
    return [{"module": "jupyterlab_bucket_explorer"}]


def _load_jupyter_server_extension(server_app):
    """Registers the API handler to receive HTTP requests from the frontend extension.

    Parameters
    ----------
    server_app: jupyterlab.labapp.LabApp
        JupyterLab application instance
    """
    s3_config = JupyterLabS3(config=server_app.config)
    server_app.web_app.settings["s3_config"] = s3_config
    setup_handlers(server_app.web_app)
    name = "jupyterlab-bucket-explorer"
    server_app.log.info(f"Registered {name} server extension")


# For backward compatibility with notebook server - useful for Binder/JupyterHub
load_jupyter_server_extension = _load_jupyter_server_extension
_jupyter_server_extension_paths = _jupyter_server_extension_points
