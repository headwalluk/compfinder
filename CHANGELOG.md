# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `compfinder` command, with `--output=text|json` and `--help` on every command.
- `compfinder providers list`: the built-in providers and whether each is configured, with no
  network calls.
- `compfinder config init`, `config path` and `config show`: write the commented config
  template, find the config file in use, and see every effective setting and where it came from.
- Configuration from `~/.config/compfinder/config.toml`, with `COMPFINDER_*` environment
  variables and command-line flags as overrides. Every problem is reported at once.
