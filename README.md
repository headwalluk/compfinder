# compfinder

![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)

compfinder is a command-line tool that takes a few facts about a business (a name, a web
address, a postcode) and finds out what it can about it: its website, address, phone number,
email, logo, social profiles and Google place ID. Every value comes with the sources it came
from and a confidence score, so you, or a script or an AI agent calling the tool, can decide
what's good enough to use.

It gathers evidence from built-in providers. `web-fetch` reads the business's own pages and
needs no key. Google Places, SearchAPI.io, Brave Search and Apollo.io each add detail and
confidence once you give them an API key. compfinder is deterministic: it makes no LLM calls,
and the same provider responses always give the same answer.

**Status:** early development. Configuration and `providers list` work today. Business lookups
(`compfinder find`) are being built.

```sh
npm install -g @headwall/compfinder
compfinder config init        # writes ~/.config/compfinder/config.toml
compfinder providers list     # shows which providers are configured
```

## Documentation

For people running compfinder:

- [Documentation index](docs/README.md)
- [Configuration](docs/configuration.md): the config file, every setting, environment overrides
- [Command line](docs/cli.md): every command and option, output formats, exit codes

For scripts and agents reading the output:

- [Output](docs/output.md): the JSON result and its schema
- [Confidence](docs/confidence.md): what the scores mean

For developers:

- [Changelog](CHANGELOG.md)

## Licence

MIT. See [LICENSE](LICENSE).
