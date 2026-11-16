# Deferred feature wishes

This is the maintained list of optional product wishes, separate from current
bug fixes and release acceptance. An entry does not promise a release date.

## Guided installation CLI

Priority: deferred; Linux first. Windows and macOS are desired follow-up platforms.

A self-explanatory installation command should guide a new installation through:

1. Prerequisite checks for the supported Docker/Compose environment.
2. An explicit choice of no remote Git or an existing Git/GitHub repository;
   when selected, ask for the repository URL and explain authentication.
3. Creation of `.env` and a supported Docker Compose configuration.
4. Starting the services and displaying the application URL and useful checks.

Use the same supported images, configuration and startup path as manual setup;
do not maintain a second installation architecture. Explain required choices
in ordinary language. Preserve existing `.env`, configuration and nonempty data;
never silently replace an installation or print credentials. The installer is
not implemented by this entry and is not required for the current deployment fix.
