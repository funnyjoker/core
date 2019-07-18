"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const nls = require("vscode-nls");
const bufferSyncSupport_1 = require("./features/bufferSyncSupport");
const diagnostics_1 = require("./features/diagnostics");
const server_1 = require("./tsServer/server");
const api_1 = require("./utils/api");
const configuration_1 = require("./utils/configuration");
const dispose_1 = require("./utils/dispose");
const fileSchemes = require("./utils/fileSchemes");
const logger_1 = require("./utils/logger");
const pluginPathsProvider_1 = require("./utils/pluginPathsProvider");
const telemetry_1 = require("./utils/telemetry");
const tracer_1 = require("./utils/tracer");
const tsconfig_1 = require("./utils/tsconfig");
const versionPicker_1 = require("./utils/versionPicker");
const versionProvider_1 = require("./utils/versionProvider");
const localize = nls.loadMessageBundle();
class TypeScriptServiceClient extends dispose_1.Disposable {
    constructor(workspaceState, onDidChangeTypeScriptVersion, pluginManager, logDirectoryProvider, allModeIds) {
        super();
        this.workspaceState = workspaceState;
        this.onDidChangeTypeScriptVersion = onDidChangeTypeScriptVersion;
        this.pluginManager = pluginManager;
        this.logDirectoryProvider = logDirectoryProvider;
        this.logger = new logger_1.default();
        this.isRestarting = false;
        this.loadingIndicator = new ServerInitializingIndicator();
        this._onTsServerStarted = this._register(new vscode.EventEmitter());
        this.onTsServerStarted = this._onTsServerStarted.event;
        this._onDiagnosticsReceived = this._register(new vscode.EventEmitter());
        this.onDiagnosticsReceived = this._onDiagnosticsReceived.event;
        this._onConfigDiagnosticsReceived = this._register(new vscode.EventEmitter());
        this.onConfigDiagnosticsReceived = this._onConfigDiagnosticsReceived.event;
        this._onResendModelsRequested = this._register(new vscode.EventEmitter());
        this.onResendModelsRequested = this._onResendModelsRequested.event;
        this._onProjectLanguageServiceStateChanged = this._register(new vscode.EventEmitter());
        this.onProjectLanguageServiceStateChanged = this._onProjectLanguageServiceStateChanged.event;
        this._onDidBeginInstallTypings = this._register(new vscode.EventEmitter());
        this.onDidBeginInstallTypings = this._onDidBeginInstallTypings.event;
        this._onDidEndInstallTypings = this._register(new vscode.EventEmitter());
        this.onDidEndInstallTypings = this._onDidEndInstallTypings.event;
        this._onTypesInstallerInitializationFailed = this._register(new vscode.EventEmitter());
        this.onTypesInstallerInitializationFailed = this._onTypesInstallerInitializationFailed.event;
        this._onSurveyReady = this._register(new vscode.EventEmitter());
        this.onSurveyReady = this._onSurveyReady.event;
        this.token = 0;
        this.pathSeparator = path.sep;
        this.lastStart = Date.now();
        var p = new Promise((resolve, reject) => {
            this._onReady = { promise: p, resolve, reject };
        });
        this._onReady.promise = p;
        this.forkedTsServer = null;
        this.lastError = null;
        this.numberRestarts = 0;
        this._configuration = configuration_1.TypeScriptServiceConfiguration.loadFromWorkspace();
        this.versionProvider = new versionProvider_1.TypeScriptVersionProvider(this._configuration);
        this.pluginPathsProvider = new pluginPathsProvider_1.TypeScriptPluginPathsProvider(this._configuration);
        this.versionPicker = new versionPicker_1.TypeScriptVersionPicker(this.versionProvider, this.workspaceState);
        this._apiVersion = api_1.default.defaultVersion;
        this._tsserverVersion = undefined;
        this.tracer = new tracer_1.default(this.logger);
        this.bufferSyncSupport = new bufferSyncSupport_1.default(this, allModeIds);
        this.onReady(() => { this.bufferSyncSupport.listen(); });
        this.diagnosticsManager = new diagnostics_1.DiagnosticsManager('typescript');
        this.bufferSyncSupport.onDelete(resource => {
            this.diagnosticsManager.delete(resource);
        }, null, this._disposables);
        vscode.workspace.onDidChangeConfiguration(() => {
            const oldConfiguration = this._configuration;
            this._configuration = configuration_1.TypeScriptServiceConfiguration.loadFromWorkspace();
            this.versionProvider.updateConfiguration(this._configuration);
            this.pluginPathsProvider.updateConfiguration(this._configuration);
            this.tracer.updateConfiguration();
            if (this.forkedTsServer) {
                if (this._configuration.checkJs !== oldConfiguration.checkJs
                    || this._configuration.experimentalDecorators !== oldConfiguration.experimentalDecorators) {
                    this.setCompilerOptionsForInferredProjects(this._configuration);
                }
                if (!this._configuration.isEqualTo(oldConfiguration)) {
                    this.restartTsServer();
                }
            }
        }, this, this._disposables);
        this.telemetryReporter = this._register(new telemetry_1.default(() => this._tsserverVersion || this._apiVersion.versionString));
        this.typescriptServerSpawner = new server_1.TypeScriptServerSpawner(this.versionProvider, this.logDirectoryProvider, this.pluginPathsProvider, this.logger, this.telemetryReporter, this.tracer);
        this._register(this.pluginManager.onDidUpdateConfig(update => {
            this.configurePlugin(update.pluginId, update.config);
        }));
    }
    get configuration() {
        return this._configuration;
    }
    dispose() {
        super.dispose();
        this.bufferSyncSupport.dispose();
        if (this.forkedTsServer) {
            this.forkedTsServer.kill();
        }
        this.loadingIndicator.reset();
    }
    restartTsServer() {
        if (this.forkedTsServer) {
            this.info('Killing TS Server');
            this.isRestarting = true;
            this.forkedTsServer.kill();
            this.resetClientVersion();
        }
        this.forkedTsServer = this.startService(true);
    }
    get apiVersion() {
        return this._apiVersion;
    }
    onReady(f) {
        return this._onReady.promise.then(f);
    }
    info(message, data) {
        this.logger.info(message, data);
    }
    error(message, data) {
        this.logger.error(message, data);
    }
    logTelemetry(eventName, properties) {
        this.telemetryReporter.logTelemetry(eventName, properties);
    }
    service() {
        if (this.forkedTsServer) {
            return this.forkedTsServer;
        }
        if (this.lastError) {
            throw this.lastError;
        }
        this.startService();
        if (this.forkedTsServer) {
            return this.forkedTsServer;
        }
        throw new Error('Could not create TS service');
    }
    ensureServiceStarted() {
        if (!this.forkedTsServer) {
            this.startService();
        }
    }
    startService(resendModels = false) {
        if (this.isDisposed) {
            return null;
        }
        let currentVersion = this.versionPicker.currentVersion;
        this.info(`Using tsserver from: ${currentVersion.path}`);
        if (!fs.existsSync(currentVersion.tsServerPath)) {
            vscode.window.showWarningMessage(localize('noServerFound', 'The path {0} doesn\'t point to a valid tsserver install. Falling back to bundled TypeScript version.', currentVersion.path));
            this.versionPicker.useBundledVersion();
            currentVersion = this.versionPicker.currentVersion;
        }
        this._apiVersion = this.versionPicker.currentVersion.version || api_1.default.defaultVersion;
        this.onDidChangeTypeScriptVersion(currentVersion);
        this.lastError = null;
        let mytoken = ++this.token;
        const handle = this.typescriptServerSpawner.spawn(currentVersion, this.configuration, this.pluginManager);
        this.lastStart = Date.now();
        handle.onError((err) => {
            if (this.token !== mytoken) {
                // this is coming from an old process
                return;
            }
            if (err) {
                vscode.window.showErrorMessage(localize('serverExitedWithError', 'TypeScript language server exited with error. Error message is: {0}', err.message || err.name));
            }
            this.lastError = err;
            this.error('TSServer errored with error.', err);
            if (handle.tsServerLogFile) {
                this.error(`TSServer log file: ${handle.tsServerLogFile}`);
            }
            /* __GDPR__
                "tsserver.error" : {
                    "${include}": [
                        "${TypeScriptCommonProperties}"
                    ]
                }
            */
            this.logTelemetry('tsserver.error');
            this.serviceExited(false);
            this.resetClientVersion();
        });
        handle.onExit((code) => {
            if (this.token !== mytoken) {
                // this is coming from an old process
                return;
            }
            if (code === null || typeof code === 'undefined') {
                this.info('TSServer exited');
            }
            else {
                this.error(`TSServer exited with code: ${code}`);
                /* __GDPR__
                    "tsserver.exitWithCode" : {
                        "code" : { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" },
                        "${include}": [
                            "${TypeScriptCommonProperties}"
                        ]
                    }
                */
                this.logTelemetry('tsserver.exitWithCode', { code: code });
            }
            if (handle.tsServerLogFile) {
                this.info(`TSServer log file: ${handle.tsServerLogFile}`);
            }
            this.serviceExited(!this.isRestarting);
            this.isRestarting = false;
        });
        handle.onReaderError(error => this.error('ReaderError', error));
        handle.onEvent(event => this.dispatchEvent(event));
        this._onReady.resolve();
        this.forkedTsServer = handle;
        this._onTsServerStarted.fire(currentVersion.version);
        if (this._apiVersion.gte(api_1.default.v300)) {
            this.loadingIndicator.startedLoadingProject(undefined /* projectName */);
        }
        this.serviceStarted(resendModels);
        return handle;
    }
    onVersionStatusClicked() {
        return this.showVersionPicker(false);
    }
    showVersionPicker(firstRun) {
        return this.versionPicker.show(firstRun).then(change => {
            if (firstRun || !change.newVersion || !change.oldVersion || change.oldVersion.path === change.newVersion.path) {
                return;
            }
            this.restartTsServer();
        });
    }
    async openTsServerLogFile() {
        if (this.apiVersion.lt(api_1.default.v222)) {
            vscode.window.showErrorMessage(localize('typescript.openTsServerLog.notSupported', 'TS Server logging requires TS 2.2.2+'));
            return false;
        }
        if (this._configuration.tsServerLogLevel === configuration_1.TsServerLogLevel.Off) {
            vscode.window.showErrorMessage(localize('typescript.openTsServerLog.loggingNotEnabled', 'TS Server logging is off. Please set `typescript.tsserver.log` and restart the TS server to enable logging'), {
                title: localize('typescript.openTsServerLog.enableAndReloadOption', 'Enable logging and restart TS server'),
            })
                .then(selection => {
                if (selection) {
                    return vscode.workspace.getConfiguration().update('typescript.tsserver.log', 'verbose', true).then(() => {
                        this.restartTsServer();
                    });
                }
                return undefined;
            });
            return false;
        }
        if (!this.forkedTsServer || !this.forkedTsServer.tsServerLogFile) {
            vscode.window.showWarningMessage(localize('typescript.openTsServerLog.noLogFile', 'TS Server has not started logging.'));
            return false;
        }
        try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.forkedTsServer.tsServerLogFile));
            return true;
        }
        catch (_a) {
            vscode.window.showWarningMessage(localize('openTsServerLog.openFileFailedFailed', 'Could not open TS Server log file'));
            return false;
        }
    }
    serviceStarted(resendModels) {
        const configureOptions = {
            hostInfo: 'vscode',
        };
        this.executeWithoutWaitingForResponse('configure', configureOptions);
        this.setCompilerOptionsForInferredProjects(this._configuration);
        if (resendModels) {
            this._onResendModelsRequested.fire();
        }
        // Reconfigure any plugins
        for (const [config, pluginName] of this.pluginManager.configurations()) {
            this.configurePlugin(config, pluginName);
        }
    }
    setCompilerOptionsForInferredProjects(configuration, extraCompilerOptions = {}) {
        if (this.apiVersion.lt(api_1.default.v206)) {
            return;
        }
        const args = {
            options: Object.assign({}, this.getCompilerOptionsForInferredProjects(configuration), extraCompilerOptions)
        };
        this.executeWithoutWaitingForResponse('compilerOptionsForInferredProjects', args);
    }
    getCompilerOptionsForInferredProjects(configuration) {
        return Object.assign({}, tsconfig_1.inferredProjectConfig(configuration), { allowJs: true, allowSyntheticDefaultImports: true, allowNonTsExtensions: true });
    }
    serviceExited(restart) {
        this.loadingIndicator.reset();
        let MessageAction;
        (function (MessageAction) {
            MessageAction[MessageAction["reportIssue"] = 0] = "reportIssue";
        })(MessageAction || (MessageAction = {}));
        this.forkedTsServer = null;
        if (!restart) {
            this.resetClientVersion();
        }
        else {
            const diff = Date.now() - this.lastStart;
            this.numberRestarts++;
            let startService = true;
            if (this.numberRestarts > 5) {
                let prompt = undefined;
                this.numberRestarts = 0;
                if (diff < 10 * 1000 /* 10 seconds */) {
                    this.lastStart = Date.now();
                    startService = false;
                    prompt = vscode.window.showErrorMessage(localize('serverDiedAfterStart', 'The TypeScript language service died 5 times right after it got started. The service will not be restarted.'), {
                        title: localize('serverDiedReportIssue', 'Report Issue'),
                        id: MessageAction.reportIssue,
                    });
                    /* __GDPR__
                        "serviceExited" : {
                            "${include}": [
                                "${TypeScriptCommonProperties}"
                            ]
                        }
                    */
                    this.logTelemetry('serviceExited');
                    this.resetClientVersion();
                }
                else if (diff < 60 * 1000 /* 1 Minutes */) {
                    this.lastStart = Date.now();
                    prompt = vscode.window.showWarningMessage(localize('serverDied', 'The TypeScript language service died unexpectedly 5 times in the last 5 Minutes.'), {
                        title: localize('serverDiedReportIssue', 'Report Issue'),
                        id: MessageAction.reportIssue
                    });
                }
                if (prompt) {
                    prompt.then(item => {
                        if (item && item.id === MessageAction.reportIssue) {
                            return vscode.commands.executeCommand('workbench.action.reportIssues');
                        }
                        return undefined;
                    });
                }
            }
            if (startService) {
                this.startService(true);
            }
        }
    }
    normalizedPath(resource) {
        if (this._apiVersion.gte(api_1.default.v213)) {
            if (resource.scheme === fileSchemes.walkThroughSnippet || resource.scheme === fileSchemes.untitled) {
                const dirName = path.dirname(resource.path);
                const fileName = this.inMemoryResourcePrefix + path.basename(resource.path);
                return resource.with({ path: path.posix.join(dirName, fileName) }).toString(true);
            }
        }
        if (resource.scheme !== fileSchemes.file) {
            return null;
        }
        const result = resource.fsPath;
        if (!result) {
            return null;
        }
        // Both \ and / must be escaped in regular expressions
        return result.replace(new RegExp('\\' + this.pathSeparator, 'g'), '/');
    }
    toPath(resource) {
        return this.normalizedPath(resource);
    }
    get inMemoryResourcePrefix() {
        return this._apiVersion.gte(api_1.default.v270) ? '^' : '';
    }
    toResource(filepath) {
        if (this._apiVersion.gte(api_1.default.v213)) {
            if (filepath.startsWith(TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME_COLON) || (filepath.startsWith(fileSchemes.untitled + ':'))) {
                let resource = vscode.Uri.parse(filepath);
                if (this.inMemoryResourcePrefix) {
                    const dirName = path.dirname(resource.path);
                    const fileName = path.basename(resource.path);
                    if (fileName.startsWith(this.inMemoryResourcePrefix)) {
                        resource = resource.with({ path: path.posix.join(dirName, fileName.slice(this.inMemoryResourcePrefix.length)) });
                    }
                }
                return resource;
            }
        }
        return this.bufferSyncSupport.toResource(filepath);
    }
    getWorkspaceRootForResource(resource) {
        const roots = vscode.workspace.workspaceFolders;
        if (!roots || !roots.length) {
            return undefined;
        }
        if (resource.scheme === fileSchemes.file || resource.scheme === fileSchemes.untitled) {
            for (const root of roots.sort((a, b) => a.uri.fsPath.length - b.uri.fsPath.length)) {
                if (resource.fsPath.startsWith(root.uri.fsPath + path.sep)) {
                    return root.uri.fsPath;
                }
            }
            return roots[0].uri.fsPath;
        }
        return undefined;
    }
    execute(command, args, token, lowPriority) {
        return this.executeImpl(command, args, {
            isAsync: false,
            token,
            expectsResult: true,
            lowPriority
        });
    }
    executeWithoutWaitingForResponse(command, args) {
        this.executeImpl(command, args, {
            isAsync: false,
            token: undefined,
            expectsResult: false
        });
    }
    executeAsync(command, args, token) {
        return this.executeImpl(command, args, {
            isAsync: true,
            token,
            expectsResult: true
        });
    }
    executeImpl(command, args, executeInfo) {
        const server = this.service();
        if (!server) {
            return Promise.reject(new Error('Could not load TS Server'));
        }
        return server.executeImpl(command, args, executeInfo);
    }
    interuptGetErr(f) {
        return this.bufferSyncSupport.interuptGetErr(f);
    }
    dispatchEvent(event) {
        switch (event.event) {
            case 'syntaxDiag':
            case 'semanticDiag':
            case 'suggestionDiag':
                // This event also roughly signals that the global project has been loaded successfully
                this.loadingIndicator.finishedLoadingProject(undefined /* projectName */);
                const diagnosticEvent = event;
                if (diagnosticEvent.body && diagnosticEvent.body.diagnostics) {
                    this._onDiagnosticsReceived.fire({
                        kind: getDignosticsKind(event),
                        resource: this.toResource(diagnosticEvent.body.file),
                        diagnostics: diagnosticEvent.body.diagnostics
                    });
                }
                break;
            case 'configFileDiag':
                this._onConfigDiagnosticsReceived.fire(event);
                break;
            case 'telemetry':
                const telemetryData = event.body;
                this.dispatchTelemetryEvent(telemetryData);
                break;
            case 'projectLanguageServiceState':
                this._onProjectLanguageServiceStateChanged.fire(event.body);
                break;
            case 'projectsUpdatedInBackground':
                const body = event.body;
                const resources = body.openFiles.map(vscode.Uri.file);
                this.bufferSyncSupport.getErr(resources);
                break;
            case 'beginInstallTypes':
                this._onDidBeginInstallTypings.fire(event.body);
                break;
            case 'endInstallTypes':
                this._onDidEndInstallTypings.fire(event.body);
                break;
            case 'typesInstallerInitializationFailed':
                this._onTypesInstallerInitializationFailed.fire(event.body);
                break;
            case 'surveyReady':
                this._onSurveyReady.fire(event.body);
                break;
            case 'projectLoadingStart':
                this.loadingIndicator.startedLoadingProject(event.body.projectName);
                break;
            case 'projectLoadingFinish':
                this.loadingIndicator.finishedLoadingProject(event.body.projectName);
                break;
        }
    }
    dispatchTelemetryEvent(telemetryData) {
        const properties = Object.create(null);
        switch (telemetryData.telemetryEventName) {
            case 'typingsInstalled':
                const typingsInstalledPayload = telemetryData.payload;
                properties['installedPackages'] = typingsInstalledPayload.installedPackages;
                if (typeof typingsInstalledPayload.installSuccess === 'boolean') {
                    properties['installSuccess'] = typingsInstalledPayload.installSuccess.toString();
                }
                if (typeof typingsInstalledPayload.typingsInstallerVersion === 'string') {
                    properties['typingsInstallerVersion'] = typingsInstalledPayload.typingsInstallerVersion;
                }
                break;
            default:
                const payload = telemetryData.payload;
                if (payload) {
                    Object.keys(payload).forEach((key) => {
                        try {
                            if (payload.hasOwnProperty(key)) {
                                properties[key] = typeof payload[key] === 'string' ? payload[key] : JSON.stringify(payload[key]);
                            }
                        }
                        catch (e) {
                            // noop
                        }
                    });
                }
                break;
        }
        if (telemetryData.telemetryEventName === 'projectInfo') {
            this._tsserverVersion = properties['version'];
        }
        /* __GDPR__
            "typingsInstalled" : {
                "installedPackages" : { "classification": "PublicNonPersonalData", "purpose": "FeatureInsight" },
                "installSuccess": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
                "typingsInstallerVersion": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
                "${include}": [
                    "${TypeScriptCommonProperties}"
                ]
            }
        */
        // __GDPR__COMMENT__: Other events are defined by TypeScript.
        this.logTelemetry(telemetryData.telemetryEventName, properties);
    }
    resetClientVersion() {
        this._apiVersion = api_1.default.defaultVersion;
        this._tsserverVersion = undefined;
    }
    configurePlugin(pluginName, configuration) {
        if (this._apiVersion.gte(api_1.default.v314)) {
            this.executeWithoutWaitingForResponse('configurePlugin', { pluginName, configuration });
        }
    }
}
TypeScriptServiceClient.WALK_THROUGH_SNIPPET_SCHEME_COLON = `${fileSchemes.walkThroughSnippet}:`;
exports.default = TypeScriptServiceClient;
function getDignosticsKind(event) {
    switch (event.event) {
        case 'syntaxDiag': return 0 /* Syntax */;
        case 'semanticDiag': return 1 /* Semantic */;
        case 'suggestionDiag': return 2 /* Suggestion */;
    }
    throw new Error('Unknown dignostics kind');
}
class ServerInitializingIndicator extends dispose_1.Disposable {
    reset() {
        if (this._task) {
            this._task.reject();
            this._task = undefined;
        }
    }
    /**
     * Signal that a project has started loading.
     */
    startedLoadingProject(projectName) {
        // TS projects are loaded sequentially. Cancel existing task because it should always be resolved before
        // the incoming project loading task is.
        this.reset();
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: localize('serverLoading.progress', "Initializing JS/TS language features"),
        }, () => new Promise((resolve, reject) => {
            this._task = { project: projectName, resolve, reject };
        }));
    }
    finishedLoadingProject(projectName) {
        if (this._task && this._task.project === projectName) {
            this._task.resolve();
            this._task = undefined;
        }
    }
}
