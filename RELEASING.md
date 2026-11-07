# Releasing

Extension ID: **FirozKhan.w3c-validator-plus**

## One-time setup

### 1. Repository details in package.json

Replace the `your-github-user` placeholders in `repository`, `bugs` and `homepage`.
`npm run release:check` fails until this is done.

### 2. VS Code Marketplace (trusted publishing, no stored token)

The release workflow signs in to Microsoft Entra ID with GitHub's OIDC token and runs
`vsce publish --azure-credential`.

1. In the [Azure portal](https://portal.azure.com), create an **App registration**
   (Microsoft Entra ID → App registrations → New registration).
2. In the app: **Certificates & secrets → Federated credentials → Add credential →
   GitHub Actions deploying Azure resources**. Organization/repository: your repo;
   entity type: **Environment**; environment name: `marketplace`.
3. Give that identity access to the **FirozKhan** publisher, following Microsoft's
   "Publishing Extensions" guide (section on automated publishing with Microsoft Entra ID):
   https://code.visualstudio.com/api/working-with-extensions/publishing-extension
4. In GitHub: **Settings → Environments → New environment** `marketplace`
   (optionally require a reviewer), then **Settings → Secrets and variables → Actions →
   Variables**: `AZURE_CLIENT_ID` (the app's Application (client) ID) and
   `AZURE_TENANT_ID` (Directory (tenant) ID).

### 3. Open VSX

1. Sign in at https://open-vsx.org with GitHub, accept the publisher agreement, and create
   an access token (avatar → Settings → Access Tokens).
2. Create the namespace once: `npx ovsx create-namespace FirozKhan --pat <token>`.
3. In GitHub, create environment `openvsx` and add secret `OVSX_PAT` with the token.

## Each release

1. Update `version` in `package.json` (semver; it must be higher than the published one).
2. In `CHANGELOG.md`, rename the top section to `## <version> (YYYY-MM-DD)`.
3. `npm run release:check && npm test`
4. Optional: `npx vsce package --no-dependencies` and install the `.vsix` in a clean profile:
   `code --user-data-dir /tmp/vsc --extensions-dir /tmp/vsc-ext --install-extension <file>.vsix`
5. Commit, then tag and push: `git tag v<version> && git push origin main v<version>`.

The **Release** workflow tests, packages once, publishes the same `.vsix` to the Marketplace
and Open VSX, and attaches it to a GitHub release. Marketplace verification usually takes a
few minutes.

## Manual publish (fallback)

```sh
npx vsce login FirozKhan                 # asks for an Azure DevOps token with Marketplace (Manage) scope
npx vsce publish --no-dependencies
npx ovsx publish <file>.vsix --pat <open-vsx-token>
```
