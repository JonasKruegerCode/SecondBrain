# Release channels

`main` contains the accepted application and publishes both container images as
`latest`. `develop` contains the next version under evaluation and publishes both
images as `next`. Every publication also retains a `sha-<commit>` tag for a
specific build. No numbered release is implied by a channel build.

Both image workflows run for every push to either branch so frontend and backend
are published from the same commit, including configuration-only changes. The two
images publish independently: complete both builds before pulling a channel or
changing an installation. Failed tests prevent the corresponding publication.
Pull requests to either branch retain the existing full validation workflows.
Automatic `latest` inference is disabled; only `main` may write `latest` and only
`develop` may write `next`.

Work in feature branches and merge into `develop` with explicit approval. After
acceptance, open a release PR from `develop` to `main`. Use a merge commit rather
than rewriting history. Hotfixes applied to `main` should also be merged into
`develop` before the next release.

## Initial separation

The stable restoration reverts PR21 first and PR20 second, retaining PR19. The
application files match the pre-PR20 commit; workflow and channel documentation
changes are deliberate additions. After this restoration is merged, create
`develop` from that new `main` and revert the two revert commits in reverse order.
This restores the tested Next application while preserving the channel changes
and records the restoration as new history. A future ordinary release merge can
therefore include these changes without another revert workaround.

## Installation

Use the Compose and environment template from the branch matching the selected
channel: the stable installation and the Next installation have different service
layouts. The Next Compose is the self-contained image installation with separate
REST and MCP services. Its source-build and optional database overlays are
explicitly documented there.

For Next, set these non-secret environment entries in the installation's `.env`:

```dotenv
WIKI_BACKEND_IMAGE=ghcr.io/jonaskruegercode/secondbrain-backend:next
WIKI_FRONTEND_IMAGE=ghcr.io/jonaskruegercode/secondbrain-frontend:next
```

Then use ordinary `docker compose pull` and `docker compose up -d`. Watchtower
continues following the tag configured on each container; it does not choose a
channel or change Compose files. Never use the older stable images with the new
Next service layout as a rollback. Retain matching images, Compose, configuration
and persistent data layout when choosing a known previous installation.
