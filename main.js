const jsModbus = require('jsmodbus')
const net = require('net')
const { InstanceBase, Regex, runEntrypoint, InstanceStatus } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const UpdateActions = require('./actions')
const UpdateFeedbacks = require('./feedbacks')
const UpdateVariableDefinitions = require('./variables')

class ModuleInstance extends InstanceBase {
    constructor(internal) {
        super(internal)
        this.client = null;
        this.socket = null;
        this.lastCoilStates = [];
        this.variables = {};
        this.numCoils = 48;
        this.numDiscreteInputs = 48;
        this.debug = false;
        this.serverIP = "127.0.0.1";
        this.serverPort = 502;
        this.reconnectTimer = null;
        this.isReconnecting = false;
        this.maxReconnectAttempts = 100;
        this.reconnectAttempts = 0;
        this.levelStates = [];
        this.pollInterval = null;
    }

    async init(config) {
        this.config = config
        this.numCoils = config.numCoils || 48;
        this.numDiscreteInputs = config.numDiscreteInputs || 48;
        this.lastCoilStates = Array(this.numCoils).fill(0);
        this.debug = config.debug || false;
        this.serverIP = config.serverIP || "127.0.0.1";
        this.serverPort = config.serverPort || 502;
        this.levelStates = Array(this.numCoils).fill(0);

        this.initActions()
        this.updateActions()
        this.updateFeedbacks()
        this.updateVariableDefinitions()
        
        this.connectModbusClient()
    }

    async destroy() {
        this.debugLog('debug', 'destroy')
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval)
        }
        if (this.socket) {
            this.socket.end()
        }
    }

    connectModbusClient() {
        if (this.isReconnecting) {
            return
        }

        this.socket = new net.Socket()
        this.client = new jsModbus.client.TCP(this.socket)

        this.socket.on('connect', () => {
            this.debugLog('info', `Connected to Modbus server at ${this.serverIP}:${this.serverPort}`)
            this.updateStatus(InstanceStatus.Ok)
            this.setVariableValues({ connected_status: 'true' })
            this.reconnectAttempts = 0
            this.isReconnecting = false

            // Start polling coils
            if (this.pollInterval) {
                clearInterval(this.pollInterval)
            }
            this.pollInterval = setInterval(() => this.pollCoils(), 1000)
        })

        this.socket.on('error', (err) => {
            this.debugLog('error', `Socket error: ${err.message}`)
            this.scheduleReconnect()
        })

        this.socket.on('close', () => {
            this.updateStatus(InstanceStatus.ConnectionError)
            this.setVariableValues({ connected_status: 'false' })
            if (this.pollInterval) {
                clearInterval(this.pollInterval)
            }
            this.scheduleReconnect()
        })

        this.socket.connect({
            host: this.serverIP,
            port: this.serverPort
        })
    }

    async pollCoils() {
        if (!this.client) return

        try {
            const response = await this.client.readCoils(0, this.numCoils)
            const coilsData = Array.from(response.response._body._valuesAsArray)
            this.updateVariableValues(coilsData)
        } catch (err) {
            this.debugLog('error', `Failed to poll coils: ${err.message}`)
        }
    }

    async setCoil(coilNumber, value) {
        if (!this.client || coilNumber < 0 || coilNumber >= this.numCoils) {
            return
        }

        try {
            await this.client.writeSingleCoil(coilNumber, value)
            this.updateVariable(coilNumber, value)
            this.debugLog('info', `Set coil ${coilNumber} to ${value}`)
        } catch (err) {
            this.debugLog('error', `Failed to set coil ${coilNumber}: ${err.message}`)
        }
    }

    scheduleReconnect(delay = 5000) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.debugLog('error', 'Max reconnection attempts reached')
            return
        }

        if (!this.isReconnecting) {
            this.isReconnecting = true
            this.reconnectAttempts++
            
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer)
            }

            this.reconnectTimer = setTimeout(() => {
                this.debugLog('info', `Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
                this.connectModbusClient()
            }, delay)
        }
    }

    // Helper method for conditional logging
    debugLog(level, ...args) {
        if (this.debug || level === 'error') {
            this.log(level, ...args);
        }
    }

    async configUpdated(config) {
        this.debugLog('info', 'Config updated');
        this.config = config;
        this.debug = config.debug || false;
        this.numCoils = config.numCoils || 48;
        this.numDiscreteInputs = config.numDiscreteInputs || 48;
        this.serverPort = config.serverPort || 502;
        
        // Reinitialize coil states array if number of coils changed
        if (this.lastCoilStates.length !== this.numCoils) {
            this.lastCoilStates = Array(this.numCoils).fill(0);
        }

        // Update variable definitions with new coil count
        this.updateVariableDefinitions();
    }

    initActions() {}

    updateVariable(index, value) {
        const updates = {
            [`coil_${index}`]: value ? 'true' : 'false'
        };
        
        // Update level state - only set to true, never back to false
        if (value) {
            this.levelStates[index] = 1;
            updates[`coil_level_${index}`] = 'true';
        }
        
        this.setVariableValues(updates);
    }

    // Add method to reset level states
    resetLevelStates() {
        this.levelStates = Array(this.numCoils).fill(0);
        const resetValues = {};
        for (let i = 0; i < this.numCoils; i++) {
            resetValues[`coil_level_${i}`] = 'false';
        }
        this.setVariableValues(resetValues);
    }

    updateVariableValues(coilsData) {
        const values = {};
        for (let i = 0; i < this.numCoils; i++) {
            values[`coil_${i}`] = coilsData[i] ? 'true' : 'false';
            // Maintain level state - only update if coil is true
            if (coilsData[i]) {
                this.levelStates[i] = 1;
                values[`coil_level_${i}`] = 'true';
            }
        }
        this.setVariableValues(values);
    }

    getConfigFields() {
        return [
            {
                type: 'textinput',
                id: 'serverIP',
                label: 'Server XX IP (0.0.0.0 for all interfaces)',
                width: 6,
                regex: Regex.IP,
                default: '0.0.0.0',
            },
            {
                type: 'number',
                id: 'serverPort',
                label: 'Server Port',
                width: 6,
                default: 502,
                min: 1,
                max: 65535,
            },
            {
                type: 'number',
                id: 'numCoils',
                label: 'Number of Coils',
                width: 4,
                default: 48,
                min: 1,
                max: 1000,
            },
            {
                type: 'number',
                id: 'numDiscreteInputs',
                label: 'Number of Discrete Inputs',
                width: 4,
                default: 48,
                min: 1,
                max: 1000,
            },
            {
                type: 'checkbox',
                id: 'debug',
                label: 'Enable Debug Logging',
                width: 4,
                default: false,
            },
        ]
    }

    updateActions() {
        UpdateActions(this)
    }

    updateFeedbacks() {
        UpdateFeedbacks(this)
    }

    updateVariableDefinitions() {
        UpdateVariableDefinitions(this)
    }

    setActions(actions) {
        this.actions = actions;
    }

    async disconnectServer() {
        if (this.server) {
            this.server.close(() => {
                this.debugLog('info', 'Server disconnected');
                this.updateFeedbacks();
            });
        }
    }

    // Handle setting individual coils
    setCoilState(coilNumber, state) {
        // Convert dropdown value to boolean
        const value = state === 1;
        this.setCoil(coilNumber, value);
    }
}

runEntrypoint(ModuleInstance, UpgradeScripts)
