/**
 * User-visible brand constants.
 *
 * Keep stable protocol, storage, environment, and package identifiers separate
 * from display copy unless a release explicitly targets a white-label rename.
 */

import brandConfig from '../../../branding.json';

export const PRODUCT_NAME = brandConfig.productName;
export const PRODUCT_NAME_SHORT = brandConfig.productNameShort;
export const PRODUCT_NAME_STYLIZED = brandConfig.stylizedName;
export const CLI_COMMAND = brandConfig.cliCommand;
export const NPM_PACKAGE_NAME = brandConfig.npmPackage;
export const RUNTIME_BRIDGE_NAME = brandConfig.runtimeBridgeName;
export const AUTH_ACCOUNT_LABEL = brandConfig.authAccountLabel;
export const AUTH_PROVIDER_NAME = brandConfig.authProviderName;
export const DEFAULT_LOCAL_HOME_NAME = brandConfig.defaultLocalHomeName;
export const GITHUB_REPO = brandConfig.githubRepo;
export const PUBLIC_DOCS_URL = brandConfig.publicDocsUrl;
