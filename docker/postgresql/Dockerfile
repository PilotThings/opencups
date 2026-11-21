# copencups/postgresql — PostgreSQL image for the OpenCUPS server.
# The schema itself is created/migrated by the Node server at startup
# (server/src/db.js); this image only provisions the database and role.
FROM postgres:16.4-alpine

ENV POSTGRES_DB=opencups \
    POSTGRES_USER=opencups \
    POSTGRES_PASSWORD=opencups

COPY init/ /docker-entrypoint-initdb.d/

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" || exit 1
