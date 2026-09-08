# Upgrading

## Updating IPP

IPP keeps no state, so updating is a matter of pulling the new image and recreating the container:

```bash
docker-compose pull
docker-compose up -d
```

If you pin a version tag rather than `latest`, bump it in your `docker-compose.yml` first (see
[Docker images](/installation#docker-images) for the tag scheme).

Check the [release notes](https://github.com/alangrainger/immich-public-proxy/releases) before moving to a new major
version. Breaking changes and renamed config keys land in major versions and are listed there.

## Immich version

IPP requires **Immich 2.0.0 or newer** and checks the server version at startup. Against an older Immich it logs a
fatal error and exits; if it can't determine the version at all (Immich unreachable), it logs a warning and carries on.

When you upgrade Immich, check the IPP release notes for a matching release, as changes to Immich's API are picked up
there.

## Config keys

Renamed or reshaped config keys keep working through backward-compatibility shims, with a deprecation notice logged
at startup. [Legacy config keys](/config/upgrading) maps each old form to its current name.
