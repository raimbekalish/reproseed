# License decision

The repository owner approved the MIT license for ReproSeed source code. The license file is [../LICENSE](../LICENSE). Its copyright line is:

```
Copyright (c) 2026 Raimbek Alish
```

`package.json` sets `"license": "MIT"`. That field describes this package. It does not relicense dependencies.

Apache-2.0 was the other license considered for ReproSeed. It was not selected. Its text stays at <http://www.apache.org/licenses/LICENSE-2.0.txt>.

## Third-party licenses

MIT applies to the ReproSeed source in this repository. Packages installed from npm keep the licenses in their own manifests. From `package-lock.json` today:

| Package | Role | License |
| --- | --- | --- |
| `playwright` 1.64.1 | Runtime dependency | Apache-2.0 |
| `playwright-core` 1.64.1 | Dependency of Playwright | Apache-2.0 |
| `@playwright/test` 1.64.1 | Dev dependency | Apache-2.0 |
| `typescript` 5.9.3 | Dev dependency | Apache-2.0 |
| `@types/node` | Dev dependency | MIT |
| `undici-types` | Dependency of `@types/node` | MIT |

Publishing or redistributing those packages still has to follow their licenses. The npm package for ReproSeed does not vendor Playwright's source. An install of ReproSeed pulls Playwright from the registry under Apache-2.0.
