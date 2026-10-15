# API reference

Contract entrypoints expose owned schemas and client contracts. Their `/host` siblings provide host implementations with explicit dependencies. Hosts supply Session state, files and authority. Decode through the exported schema before executing a command. See the README examples for the goal and loop contracts.

## Public entrypoints

- `@fungi.computer/shiitake-extensions/almanac`
- `@fungi.computer/shiitake-extensions/almanac/host`
- `@fungi.computer/shiitake-extensions/question`
- `@fungi.computer/shiitake-extensions/question/client`
- `@fungi.computer/shiitake-extensions/question/host`
- `@fungi.computer/shiitake-extensions/goal`
- `@fungi.computer/shiitake-extensions/goal/host`
- `@fungi.computer/shiitake-extensions/loop`
- `@fungi.computer/shiitake-extensions/loop/host`
- `@fungi.computer/shiitake-extensions/roster`
- `@fungi.computer/shiitake-extensions/plan`
- `@fungi.computer/shiitake-extensions/plan/host`
- `@fungi.computer/shiitake-extensions/skills/source`
- `@fungi.computer/shiitake-extensions/skills`
- `@fungi.computer/shiitake-extensions/home`
- `@fungi.computer/shiitake-extensions/home/host`
- `@fungi.computer/shiitake-extensions/goal/client`
- `@fungi.computer/shiitake-extensions/loop/client`
- `@fungi.computer/shiitake-extensions/plan/client`

Type declarations ship beside each JavaScript entrypoint. The README owns usage, lifetime rules and limitations.
