# LiDAR roof cross-check service. PDAL (with EPT support) + the scientific Python
# stack come cleanly from conda-forge, so we base on miniforge and mamba-install.
FROM condaforge/miniforge3:latest

RUN mamba install -y -c conda-forge \
      "pdal>=2.6" python=3.11 numpy scipy shapely flask gunicorn \
 && mamba clean -a -y

WORKDIR /app
COPY app.py resources.geojson ./

ENV PORT=8080 PDAL_BIN=pdal
# 1 worker, several threads; each roof is one PDAL subprocess. Timeout generous for
# a cold EPT read. Cloud Run should run with --concurrency 4 so CPU isn't oversubscribed.
CMD ["sh", "-c", "exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 300 app:app"]
