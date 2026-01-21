FROM quay.io/jupyter/base-notebook:hub-5.2.1

USER root

# Install required system packages
RUN apt-get update --yes \
    && apt-get install --yes --no-install-recommends \
    curl \
    git \
    sudo \
    && rm -rf /var/lib/apt/lists/*

USER $NB_USER
WORKDIR /home/jovyan

# Copy the prebuilt extension wheel
COPY dist/jupyterlab_bucket_explorer-0.1.0-py3-none-any.whl /home/jovyan/

# Install the extension
RUN pip install --no-cache-dir /home/jovyan/jupyterlab_bucket_explorer-0.1.0-py3-none-any.whl \
    && jupyter server extension enable jupyterlab_bucket_explorer \
    && rm /home/jovyan/jupyterlab_bucket_explorer-0.1.0-py3-none-any.whl

# Expose Jupyter port
EXPOSE 8888

ENTRYPOINT ["tini", "--"]
CMD ["start-notebook.sh"]
