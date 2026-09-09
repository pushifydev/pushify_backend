// Translation structure type
export interface TranslationKeys {
  auth: {
    invalidCredentials: string;
    emailAlreadyRegistered: string;
    userNotFound: string;
    invalidRefreshToken: string;
    sessionNotFound: string;
    invalidTokenType: string;
    invalidToken: string;
    missingAuthHeader: string;
    logoutSuccess: string;
    noOrganization: string;
    invalidPassword: string;
    profileUpdated: string;
    passwordChanged: string;
    currentPasswordIncorrect: string;
    newPasswordSameAsCurrent: string;
    sessionTerminated: string;
    otherSessionsTerminated: string;
    cannotTerminateCurrentSession: string;
    passwordResetTokenSent: string;
    passwordResetTokenInvalid: string;
    passwordResetTokenExpired: string;
    passwordResetSuccess: string;
    emailVerificationSent: string;
    emailAlreadyVerified: string;
    emailVerificationInvalid: string;
    emailVerified: string;
  };
  validation: {
    invalidRequest: string;
    invalidEmail: string;
    passwordMinLength: string;
    passwordUppercase: string;
    passwordLowercase: string;
    passwordNumber: string;
    nameMinLength: string;
    nameMaxLength: string;
    required: string;
  };
  errors: {
    notFound: string;
    internalError: string;
    badRequest: string;
    unauthorized: string;
    forbidden: string;
    conflict: string;
    tooManyRequests: string;
    malformedJson: string;
  };
  projects: {
    notFound: string;
    nameRequired: string;
    created: string;
    updated: string;
    deleted: string;
    webhookRegenerated: string;
    githubRepoRequired: string;
    webhookSecretRequired: string;
    invalidGitRepoUrl: string;
    githubWebhookInstalled: string;
    githubWebhookUpdated: string;
    settingsUpdated: string;
    invalidServer: string;
    serverNotReady: string;
  };
  organizations: {
    notFound: string;
    noAccess: string;
    updated: string;
    slugTaken: string;
    userNotFound: string;
    alreadyMember: string;
    memberNotFound: string;
    memberAdded: string;
    memberRemoved: string;
    cannotChangeOwner: string;
    cannotRemoveOwner: string;
    roleUpdated: string;
    adminRequired: string;
    invitationSent: string;
    invitationNotFound: string;
    invitationRevoked: string;
    invitationAlreadyAccepted: string;
    invitationExpired: string;
    invitationAlreadyPending: string;
    invitationAccepted: string;
    invitationEmailMismatch: string;
  };
  envVars: {
    notFound: string;
    keyExists: string;
    invalidKeyFormat: string;
    created: string;
    updated: string;
    deleted: string;
    bulkUpdated: string;
  };
  domains: {
    notFound: string;
    alreadyExists: string;
    invalidFormat: string;
    created: string;
    deleted: string;
    setPrimary: string;
    verified: string;
    noServerAssigned: string;
    serverNotReady: string;
    dnsNotConfigured: string;
    dnsConfigured: string;
    dnsPointsElsewhere: string;
    nginxUpdated: string;
    nginxUpdateFailed: string;
    registrarNotConfigured: string;
    searchQueryRequired: string;
    notAvailable: string;
    premiumNotSupported: string;
    priceTooHigh: string;
    insufficientCredits: string;
    purchaseFailed: string;
    purchasedNotFound: string;
    notActiveDomain: string;
    dnsRecordInvalid: string;
    nameserversInvalid: string;
    forwardingInvalid: string;
    authCodeRequired: string;
    transferNotRegistered: string;
    transferPriceUnknown: string;
    transferStartFailed: string;
  };
  deployments: {
    notFound: string;
    created: string;
    cancelled: string;
    projectPaused: string;
    cannotCancel: string;
    cannotRollback: string;
    rollbackStarted: string;
    redeployStarted: string;
  };
  integrations: {
    notConnected: string;
    connected: string;
    disconnected: string;
    invalidState: string;
    oauthFailed: string;
    notConfigured: string;
  };
  notifications: {
    notFound: string;
    created: string;
    updated: string;
    deleted: string;
    testSent: string;
    testFailed: string;
  };
  healthChecks: {
    enabled: string;
    updated: string;
    disabled: string;
  };
  apiKeys: {
    notFound: string;
    created: string;
    revoked: string;
    updated: string;
    invalidKey: string;
    invalidScopes: string;
    insufficientScope: string;
    sessionOnly: string;
    limitReached: string;
  };
  twoFactor: {
    codeRequiredForOAuth: string;
    setupRequired: string;
    alreadyEnabled: string;
    invalidCode: string;
    notEnabled: string;
    noBackupCodes: string;
    enabled: string;
    disabled: string;
    backupCodesRegenerated: string;
    verificationRequired: string;
  };
  billing: {
    emailUpdated: string;
    stripeNotConfigured: string;
  };
  infraBilling: {
    managedNotAllowed: string;
    serverTierExceeded: string;
    insufficientWallet: string;
    billingError: string;
    topUpSuccess: string;
    invalidTopUpAmount: string;
    serverStoppedInsufficientCredits: string;
  };
  organizationBilling: {
    pastDue: string;
    suspended: string;
  };
  planLimits: {
    servers: string;
    databases: string;
    projects: string;
    deploymentsPerMonth: string;
    teamMembers: string;
    customDomains: string;
    buildMinutesPerMonth: string;
    storageGb: string;
    bandwidthGb: string;
    previewDeployments: string;
    healthChecks: string;
  };
  dashboard: {
    infraLowBalanceTitle: string;
    actionFailedDeploymentsTitle: string;
    actionFailedDeploymentsDesc: string;
    actionFailedLatestDesc: string;
    actionServerIssueTitle: string;
    actionServerSetupFailedDesc: string;
    actionServerErrorDesc: string;
    actionUsageLimitTitle: string;
    actionUsageLimitDesc: string;
    actionInProgressTitle: string;
    actionInProgressDesc: string;
    usageResourceServers: string;
    usageResourceDatabases: string;
    usageResourceProjects: string;
    usageResourceDeployments: string;
    usageResourceTeamMembers: string;
    usageResourceCustomDomains: string;
    usageResourceBuildMinutes: string;
    usageResourceStorage: string;
    usageResourceBandwidth: string;
  };
  servers: {
    notFound: string;
    created: string;
    deleted: string;
    started: string;
    stopped: string;
    rebooted: string;
    createFailed: string;
    deleteFailed: string;
    providerNotConfigured: string;
    notProvisioned: string;
    quotaExceeded: string;
    updated: string;
    nameRequired: string;
    resized: string;
    resizeFailed: string;
    resizeNotSupported: string;
    resizeInvalidState: string;
    resizeInvalidSize: string;
    snapshotsNotSupported: string;
    autoSnapshotPlanRequired: string;
    snapshotRequiresRunning: string;
    snapshotCreated: string;
    snapshotDeleted: string;
    snapshotRestoreStarted: string;
    snapshotRestoreInvalidState: string;
    notReadyForDeploy: string;
  };
  databases: {
    notFound: string;
    nameExists: string;
    serverNotReady: string;
    created: string;
    updated: string;
    deleted: string;
    alreadyConnected: string;
    connectionNotFound: string;
    connected: string;
    disconnected: string;
    mustBeRunning: string;
    invalidContainer: string;
    externalAccessEnabled: string;
    externalAccessDisabled: string;
    started: string;
    stopped: string;
    restarted: string;
    passwordReset: string;
    quotaExceeded: string;
    backupCreated: string;
    backupFailed: string;
    backupNotFound: string;
    backupDeleted: string;
    backupRestored: string;
    backupVerifyStarted: string;
    backupRestoreFailed: string;
    backupInProgress: string;
    databaseMustBeRunning: string;
    // Data browser (studio)
    studioUnsupportedEngine: string;
    studioTableNotFound: string;
    studioInvalidIdentifier: string;
    studioInvalidValue: string;
    studioInvalidFilter: string;
    studioNoPrimaryKey: string;
    studioPrimaryKeyRequired: string;
    studioNoValues: string;
    studioViewReadOnly: string;
    studioTooManyRows: string;
    studioEmptyQuery: string;
    studioQueryTooLong: string;
    studioQueryFailed: string;
    studioReadOnlyBlocked: string;
    studioRowInserted: string;
    studioRowUpdated: string;
    studioRowsDeleted: string;
    studioInvalidColumnType: string;
    studioAutoIncrementType: string;
    studioAutoIncrementKey: string;
    studioNoColumns: string;
    studioTooManyColumns: string;
    studioDuplicateColumn: string;
    studioLastColumn: string;
    studioTableCreated: string;
    studioTableDropped: string;
    studioTableTruncated: string;
    studioTableRenamed: string;
    studioColumnAdded: string;
    studioColumnDropped: string;
    studioIndexNotFound: string;
    studioPrimaryIndex: string;
    studioInvalidIndexMethod: string;
    studioIndexCreated: string;
    studioIndexDropped: string;
    studioCollectionCreated: string;
    studioCollectionDropped: string;
    studioDocumentInserted: string;
    studioDocumentUpdated: string;
    studioDocumentsDeleted: string;
    studioKeysDeleted: string;
    studioTtlUpdated: string;
    studioValueUpdated: string;
    studioRowsImported: string;
    studioQueryCancelled: string;
    studioQueryGone: string;
    studioNoAccess: string;
    studioReadOnlyAccess: string;
    studioSlowQueriesUnavailable: string;
  };
}

export const en: TranslationKeys = {
  // Auth
  auth: {
    invalidCredentials: 'Invalid email or password',
    emailAlreadyRegistered: 'Email already registered',
    userNotFound: 'User not found',
    invalidRefreshToken: 'Invalid refresh token',
    sessionNotFound: 'Session not found or expired',
    invalidTokenType: 'Invalid token type',
    invalidToken: 'Invalid or expired token',
    missingAuthHeader: 'Missing or invalid authorization header',
    logoutSuccess: 'Logged out successfully',
    noOrganization: 'User has no organization',
    invalidPassword: 'Invalid password',
    profileUpdated: 'Profile updated successfully',
    passwordChanged: 'Password changed successfully',
    currentPasswordIncorrect: 'Current password is incorrect',
    newPasswordSameAsCurrent: 'New password must be different from current password',
    sessionTerminated: 'Session terminated successfully',
    otherSessionsTerminated: 'All other sessions have been terminated',
    cannotTerminateCurrentSession: 'Cannot terminate your current session',
    passwordResetTokenSent: 'If an account with that email exists, a password reset link has been sent',
    passwordResetTokenInvalid: 'Invalid or expired password reset token',
    passwordResetTokenExpired: 'Password reset token has expired',
    passwordResetSuccess: 'Password has been reset successfully',
    emailVerificationSent: 'Verification email sent. Please check your inbox.',
    emailAlreadyVerified: 'Your email is already verified.',
    emailVerificationInvalid: 'Invalid or expired verification token.',
    emailVerified: 'Your email has been verified successfully.',
  },

  // Validation
  validation: {
    invalidRequest: 'Invalid request data',
    invalidEmail: 'Invalid email address',
    passwordMinLength: 'Password must be at least 8 characters',
    passwordUppercase: 'Password must contain at least one uppercase letter',
    passwordLowercase: 'Password must contain at least one lowercase letter',
    passwordNumber: 'Password must contain at least one number',
    nameMinLength: 'Name must be at least 2 characters',
    nameMaxLength: 'Name must be at most 100 characters',
    required: 'This field is required',
  },

  // Errors
  errors: {
    notFound: 'The requested resource was not found',
    internalError: 'An unexpected error occurred',
    badRequest: 'Bad request',
    unauthorized: 'Unauthorized',
    forbidden: 'Forbidden',
    conflict: 'Conflict',
    tooManyRequests: 'Too many requests',
    malformedJson: 'Malformed JSON in request body',
  },

  // Projects
  projects: {
    notFound: 'Project not found',
    nameRequired: 'Project name is required',
    created: 'Project created successfully',
    updated: 'Project updated successfully',
    deleted: 'Project deleted successfully',
    webhookRegenerated: 'Webhook secret regenerated successfully',
    githubRepoRequired: 'This project must use a GitHub repository',
    webhookSecretRequired: 'Generate a webhook secret before installing the GitHub webhook',
    invalidGitRepoUrl: 'Could not parse the GitHub repository URL',
    githubWebhookInstalled: 'GitHub webhook installed successfully',
    githubWebhookUpdated: 'GitHub webhook updated successfully',
    settingsUpdated: 'Project settings updated successfully',
    invalidServer: 'Selected server does not exist or does not belong to this organization',
    serverNotReady: 'Selected server is not ready for deployment',
  },

  // Organizations
  organizations: {
    notFound: 'Organization not found',
    noAccess: 'You do not have access to this organization',
    updated: 'Organization updated successfully',
    slugTaken: 'This slug is already taken',
    userNotFound: 'User not found with this email',
    alreadyMember: 'User is already a member of this organization',
    memberNotFound: 'Member not found',
    memberAdded: 'Member added successfully',
    memberRemoved: 'Member removed successfully',
    cannotChangeOwner: 'Cannot change the role of the organization owner',
    cannotRemoveOwner: 'Cannot remove the organization owner',
    roleUpdated: 'Member role updated successfully',
    adminRequired: 'Only owners and admins can perform this action',
    invitationSent: 'Invitation sent successfully',
    invitationNotFound: 'Invitation not found or has expired',
    invitationRevoked: 'Invitation revoked successfully',
    invitationAlreadyAccepted: 'This invitation has already been accepted',
    invitationExpired: 'This invitation has expired',
    invitationAlreadyPending: 'An invitation has already been sent to this email',
    invitationAccepted: 'You have successfully joined the organization',
    invitationEmailMismatch: 'This invitation was sent to a different email address',
  },

  // Environment Variables
  envVars: {
    notFound: 'Environment variable not found',
    keyExists: 'Environment variable with this key already exists',
    invalidKeyFormat: 'Key must start with a letter and contain only uppercase letters, numbers, and underscores',
    created: 'Environment variable created successfully',
    updated: 'Environment variable updated successfully',
    deleted: 'Environment variable deleted successfully',
    bulkUpdated: 'Environment variables updated successfully',
  },

  // Domains
  domains: {
    notFound: 'Domain not found',
    alreadyExists: 'This domain is already in use',
    invalidFormat: 'Invalid domain format',
    created: 'Domain added successfully',
    deleted: 'Domain removed successfully',
    setPrimary: 'Primary domain updated successfully',
    verified: 'Domain verified successfully',
    noServerAssigned: 'No server assigned to this project. Please assign a server first.',
    serverNotReady: 'Server is not ready. Please wait for server setup to complete.',
    dnsNotConfigured: 'DNS is not configured. Please add an A record pointing to the server IP.',
    dnsConfigured: 'DNS is correctly configured.',
    dnsPointsElsewhere: 'DNS points to a different IP address.',
    nginxUpdated: 'Nginx settings updated successfully',
    nginxUpdateFailed: 'Failed to apply Nginx settings to server',
    registrarNotConfigured: 'Domain purchasing is not enabled on this platform',
    searchQueryRequired: 'Enter a domain or keyword to search',
    notAvailable: 'This domain is not available for registration',
    premiumNotSupported: 'Premium domains are not supported yet',
    priceTooHigh: 'This domain exceeds the maximum purchase price',
    insufficientCredits: 'Insufficient credits. Add credits in Billing to buy this domain.',
    purchaseFailed: 'Domain registration failed. Your credits were refunded.',
    purchasedNotFound: 'Purchased domain not found',
    notActiveDomain: 'This domain is not active yet (transfer pending or expired)',
    dnsRecordInvalid: 'Invalid DNS record. Check the host, type, value, TTL and priority.',
    nameserversInvalid: 'Provide 2-6 valid nameserver hostnames',
    forwardingInvalid: 'Invalid email forwarding. Use a simple alias and a valid destination email.',
    authCodeRequired: 'The transfer auth (EPP) code is required',
    transferNotRegistered: 'This domain is not registered anywhere — you can simply buy it.',
    transferPriceUnknown: 'Could not determine the transfer price for this domain extension',
    transferStartFailed: 'Transfer could not be started. Check the auth code and that the domain is unlocked. Your credits were refunded.',
  },

  // Deployments
  deployments: {
    notFound: 'Deployment not found',
    created: 'Deployment started successfully',
    cancelled: 'Deployment cancelled',
    projectPaused: 'Cannot deploy to a paused project',
    cannotCancel: 'Cannot cancel this deployment',
    cannotRollback: 'Cannot rollback to this deployment',
    rollbackStarted: 'Rollback started successfully',
    redeployStarted: 'Redeploy started successfully',
  },

  // Integrations
  integrations: {
    notConnected: 'GitHub is not connected',
    connected: 'GitHub connected successfully',
    disconnected: 'GitHub disconnected successfully',
    invalidState: 'Invalid OAuth state',
    oauthFailed: 'OAuth authentication failed',
    notConfigured: 'GitHub OAuth is not configured',
  },

  // Notifications
  notifications: {
    notFound: 'Notification channel not found',
    created: 'Notification channel created successfully',
    updated: 'Notification channel updated successfully',
    deleted: 'Notification channel deleted successfully',
    testSent: 'Test notification sent successfully',
    testFailed: 'Failed to send test notification',
  },

  // Health Checks
  healthChecks: {
    enabled: 'Health checks enabled successfully',
    updated: 'Health check configuration updated successfully',
    disabled: 'Health checks disabled successfully',
  },

  // API Keys
  apiKeys: {
    notFound: 'API key not found',
    created: 'API key created successfully',
    revoked: 'API key revoked successfully',
    updated: 'API key updated successfully',
    invalidKey: 'Invalid or expired API key',
    invalidScopes: 'Invalid scope(s) specified',
    insufficientScope: 'API key does not have required permissions',
    sessionOnly: 'This endpoint requires a dashboard session token, not an API key',
    limitReached: 'Maximum number of API keys reached',
  },

  // Two-Factor Authentication
  twoFactor: {
    codeRequiredForOAuth:
      'Your account signs in with Google/GitHub and has no password. Enter a current authenticator code (or a backup code) to confirm.',
    setupRequired: '2FA setup required. Please generate a new secret first.',
    alreadyEnabled: '2FA is already enabled for this account',
    invalidCode: 'Invalid verification code',
    notEnabled: '2FA is not enabled for this account',
    noBackupCodes: 'No backup codes available',
    enabled: '2FA enabled successfully',
    disabled: '2FA disabled successfully',
    backupCodesRegenerated: 'Backup codes regenerated successfully',
    verificationRequired: '2FA verification required',
  },

  // Billing
  billing: {
    emailUpdated: 'Billing email updated successfully',
    stripeNotConfigured: 'Stripe is not configured',
  },

  infraBilling: {
    managedNotAllowed:
      'Managed cloud servers require a paid plan. Upgrade your platform plan or connect your own server (BYOS).',
    serverTierExceeded:
      'This server size exceeds your plan limit. Choose a smaller size or upgrade your plan.',
    insufficientWallet:
      'Insufficient infrastructure credits. Add credits in Billing before provisioning a managed server.',
    billingError: 'Infrastructure billing error',
    topUpSuccess: 'Infrastructure credits added successfully',
    invalidTopUpAmount: 'Invalid top-up amount',
    serverStoppedInsufficientCredits:
      'Stopped: insufficient infrastructure credits. Add credits in Billing to start again.',
  },

  organizationBilling: {
    pastDue:
      'Your platform subscription payment is past due. Update your payment method in Billing to create or deploy resources.',
    suspended:
      'Your platform subscription has ended. Renew your plan in Billing to resume servers, projects, and deployments.',
  },

  planLimits: {
    servers: 'Server limit reached. Upgrade your plan to add more servers.',
    databases: 'Database limit reached. Upgrade your plan to add more databases.',
    projects: 'Project limit reached. Upgrade your plan to create more projects.',
    deploymentsPerMonth:
      'Monthly deployment limit reached. Upgrade your plan or wait until next month.',
    teamMembers: 'Team member limit reached. Upgrade your plan to invite more people.',
    customDomains: 'Custom domain limit reached. Upgrade your plan to add more domains.',
    buildMinutesPerMonth:
      'Monthly build time limit reached. Upgrade your plan or wait until next month.',
    storageGb:
      'Monthly storage limit reached. Remove old images or upgrade your plan.',
    bandwidthGb:
      'Monthly bandwidth limit reached. Upgrade your plan or wait until next month.',
    previewDeployments:
      'Preview deployments are not included on your plan. Upgrade to Hobby or higher.',
    healthChecks: 'Health checks are not included on your plan. Upgrade to Hobby or higher.',
  },

  dashboard: {
    infraLowBalanceTitle: 'Low infrastructure credits',
    actionFailedDeploymentsTitle: '{count} failed deployment(s)',
    actionFailedDeploymentsDesc: 'Review logs and redeploy from the project or activity page.',
    actionFailedLatestDesc: 'Latest failure on {project} — check deployment logs.',
    actionServerIssueTitle: 'Server "{name}" needs attention',
    actionServerSetupFailedDesc: 'Initial setup did not complete. Open the server page to retry or reconnect.',
    actionServerErrorDesc: 'The server reported an error state. Verify SSH and host health.',
    actionUsageLimitTitle: 'Plan usage at {percent}%',
    actionUsageLimitDesc: '{resource} is near your plan limit. Upgrade or free capacity in Billing.',
    actionInProgressTitle: '{count} deployment(s) in progress',
    actionInProgressDesc: 'Builds and deploys are running across your projects.',
    usageResourceServers: 'Servers',
    usageResourceDatabases: 'Databases',
    usageResourceProjects: 'Projects',
    usageResourceDeployments: 'Deployments this month',
    usageResourceTeamMembers: 'Team members',
    usageResourceCustomDomains: 'Custom domains',
    usageResourceBuildMinutes: 'Build minutes this month',
    usageResourceStorage: 'Storage this month',
    usageResourceBandwidth: 'Bandwidth this month',
  },

  // Servers
  servers: {
    notFound: 'Server not found',
    created: 'Server created successfully',
    deleted: 'Server deleted successfully',
    started: 'Server started successfully',
    stopped: 'Server stopped successfully',
    rebooted: 'Server reboot initiated',
    createFailed: 'Failed to create server',
    deleteFailed: 'Failed to delete server',
    providerNotConfigured: 'Cloud provider is not configured',
    notProvisioned: 'Server is not yet provisioned',
    quotaExceeded: 'Server limit reached. Please upgrade your plan to create more servers.',
    updated: 'Server updated successfully',
    nameRequired: 'Server name is required',
    resized: 'Server resize started. It may reboot briefly.',
    resizeFailed: 'Failed to resize server',
    resizeNotSupported: 'Resize is only available for managed Hetzner servers',
    resizeInvalidState: 'Server cannot be resized in its current state',
    resizeInvalidSize: 'Invalid or unavailable size for upgrade',
    snapshotsNotSupported: 'Snapshots are only available for managed Hetzner servers',
    autoSnapshotPlanRequired: 'Automatic snapshots require a plan with snapshot quota (Hobby or higher).',
    snapshotRequiresRunning: 'Server must be running to create a snapshot',
    snapshotCreated: 'Snapshot creation started',
    snapshotDeleted: 'Snapshot deleted successfully',
    snapshotRestoreStarted:
      'Server rebuild from snapshot started. The disk will be replaced; apps may need to be redeployed.',
    snapshotRestoreInvalidState: 'Cannot restore a snapshot while the server is being created or deleted',
    notReadyForDeploy: 'Server setup must be completed before running a health scan',
  },

  // Databases
  databases: {
    notFound: 'Database not found',
    nameExists: 'A database with this name already exists',
    serverNotReady: 'Selected server is not ready for database provisioning',
    created: 'Database created successfully',
    updated: 'Database updated successfully',
    deleted: 'Database deleted successfully',
    alreadyConnected: 'Database is already connected to this project',
    connectionNotFound: 'Database connection not found',
    connected: 'Database connected to project successfully',
    disconnected: 'Database disconnected from project successfully',
    mustBeRunning: 'Database must be running to change this setting',
    invalidContainer: 'Database container configuration is invalid',
    externalAccessEnabled: 'External access enabled successfully',
    externalAccessDisabled: 'External access disabled successfully',
    started: 'Database started successfully',
    stopped: 'Database stopped successfully',
    restarted: 'Database restarted successfully',
    passwordReset: 'Database password reset successfully',
    quotaExceeded: 'Database limit reached. Please upgrade your plan to create more databases.',
    backupCreated: 'Backup created successfully',
    backupFailed: 'Backup creation failed',
    backupNotFound: 'Backup not found',
    backupDeleted: 'Backup deleted successfully',
    backupRestored: 'Database restored from backup successfully',
    backupVerifyStarted: 'Restore test started — results appear on the backup in a few minutes',
    backupRestoreFailed: 'Failed to restore database from backup',
    backupInProgress: 'A backup is already in progress for this database',
    databaseMustBeRunning: 'Database must be running to perform this action',
    // Data browser (studio)
    studioUnsupportedEngine: 'Data browser is only available for PostgreSQL and MySQL databases',
    studioTableNotFound: 'Table not found',
    studioInvalidIdentifier: 'Unknown table or column',
    studioInvalidValue: 'Unsupported value type',
    studioInvalidFilter: 'Invalid filter',
    studioNoPrimaryKey: 'This table has no primary key, so its rows cannot be edited',
    studioPrimaryKeyRequired: 'The row\'s primary key is required',
    studioNoValues: 'No values provided',
    studioViewReadOnly: 'Views are read-only',
    studioTooManyRows: 'Too many rows in a single request',
    studioEmptyQuery: 'Query is empty',
    studioQueryTooLong: 'Query is too long',
    studioQueryFailed: 'Query could not be executed',
    studioReadOnlyBlocked: 'Read-only mode allows a single SELECT statement. Enable write mode to run this.',
    studioRowInserted: 'Row added',
    studioRowUpdated: 'Row updated',
    studioRowsDeleted: 'Rows deleted',
    studioInvalidColumnType: 'Unsupported column type',
    studioAutoIncrementType: 'This type cannot auto-increment',
    studioAutoIncrementKey: 'An auto-increment column must be the primary key',
    studioNoColumns: 'Add at least one column',
    studioTooManyColumns: 'Too many columns',
    studioDuplicateColumn: 'A column with that name already exists',
    studioLastColumn: 'A table must keep at least one column',
    studioTableCreated: 'Table created',
    studioTableDropped: 'Table deleted',
    studioTableTruncated: 'Table emptied',
    studioTableRenamed: 'Table renamed',
    studioColumnAdded: 'Column added',
    studioColumnDropped: 'Column deleted',
    studioIndexNotFound: 'Index not found',
    studioPrimaryIndex: 'The primary key index cannot be dropped',
    studioInvalidIndexMethod: 'Unsupported index method',
    studioIndexCreated: 'Index created',
    studioIndexDropped: 'Index deleted',
    studioCollectionCreated: 'Collection created',
    studioCollectionDropped: 'Collection deleted',
    studioDocumentInserted: 'Document added',
    studioDocumentUpdated: 'Document updated',
    studioDocumentsDeleted: 'Documents deleted',
    studioKeysDeleted: 'Keys deleted',
    studioTtlUpdated: 'Expiry updated',
    studioValueUpdated: 'Value updated',
    studioRowsImported: 'Rows imported',
    studioQueryCancelled: 'Query cancelled',
    studioQueryGone: 'That query already finished',
    studioNoAccess: 'You do not have data-browser access to this database',
    studioReadOnlyAccess: 'Your data-browser access is read-only',
    studioSlowQueriesUnavailable: 'Query statistics are not enabled on this database (pg_stat_statements / performance_schema)',
  },
};
