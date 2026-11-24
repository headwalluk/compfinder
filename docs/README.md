# compfinder documentation

## For people running compfinder

- [Configuration](configuration.md): where the config file lives, every setting and its
  default, environment variable overrides, and precedence
- [Command line](cli.md): every command and option, the output formats, and the exit codes
- [Providers](providers.md): what each provider reads, needs and costs, and how they run in stages
- [Security](security.md): network behaviour, refused addresses, untrusted content, personal data, credentials

## For scripts and agents reading the output

- [Using compfinder from an AI agent](agents.md): preparing input, running a batch within a
  budget, and deciding what to do with each result

- [Output](output.md): the JSON result, every field, provider statuses, error codes, versioning
- [Confidence](confidence.md): what the numbers mean, and every rule that produces them

## For developers using compfinder in their own code

- [Library](library.md): `createFinder`, settings in code, errors, and examples (cleaning a list
  of leads, an HTTP API)

## For developers working on compfinder

- [Development](development.md): setup, layout, how a lookup flows, adding a provider, tests
- [Changelog](../CHANGELOG.md)
