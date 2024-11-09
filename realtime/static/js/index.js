// static/js/index.js

// UI Elements
const broadcastBtn = document.getElementById('broadcastBtn');
const listenBtn = document.getElementById('listenBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');

class AudioStreamManager {
    constructor() {
        this.broadcasterSocket = null;
        this.listenerSocket = null;
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;
        this.animationId = null;
        this.stream = null;
        this.processor = null;
        this.audioBufferQueue = [];
        this.isProcessingQueue = false;
    }

    // Initialize AudioContext and AnalyserNode for visualization
    async initAudioContext() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 2048;
                this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

                // Connect analyser to destination for visualization
                this.analyser.connect(this.audioContext.destination);
                console.log('AudioContext and AnalyserNode initialized.');
            }
            
            // Resume context if it's suspended (handles autoplay policy)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
                console.log('AudioContext resumed.');
            }
        } catch (error) {
            console.error('Error initializing AudioContext:', error);
            throw new Error('Failed to initialize audio system');
        }
    }

    // Function to continuously visualize audio data
    visualize = () => {
        if (!this.analyser || !this.dataArray) {
            console.warn('AnalyserNode or dataArray not initialized.');
            return;
        }
        this.animationId = requestAnimationFrame(this.visualize);
        this.analyser.getByteTimeDomainData(this.dataArray);
        window.drawWaveform(this.dataArray);
    }

    // Start broadcasting raw PCM 16-bit audio
    async startBroadcasting() {
        try {
            this.updateUIState('connecting');
            console.log('Starting broadcasting...');

            // Get media stream with desired audio constraints
            this.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            console.log('Media stream obtained.');

            // Initialize AudioContext
            await this.initAudioContext();

            // Create WebSocket connection
            const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
            this.broadcasterSocket = new WebSocket(`${wsProtocol}${window.location.host}/broadcast`);
            this.broadcasterSocket.binaryType = 'arraybuffer';

            // Setup WebSocket event handlers
            this.broadcasterSocket.onopen = () => {
                console.log('Broadcaster WebSocket connection opened.');
                this.updateUIState('broadcasting');
                this.setupAudioProcessor();
            };

            // Handle WebSocket errors
            this.broadcasterSocket.onerror = (error) => {
                console.error('Broadcaster WebSocket error:', error);
                this.handleError(error);
            };

            // Handle WebSocket closure
            this.broadcasterSocket.onclose = () => {
                console.log('Broadcaster WebSocket connection closed.');
                this.stopStreaming();
            };

        } catch (error) {
            console.error('Broadcasting setup error:', error);
            this.handleError(error);
        }
    }

    // Setup Audio Processing for PCM 16-bit broadcasting
    setupAudioProcessor() {
        if (!this.audioContext || !this.stream) {
            console.error('AudioContext or stream not initialized.');
            return;
        }

        // Create source from media stream
        const source = this.audioContext.createMediaStreamSource(this.stream);

        // Create ScriptProcessorNode (deprecated, consider AudioWorklet for production)
        const bufferSize = 4096; // Buffer size in samples
        const numberOfInputChannels = 1;
        const numberOfOutputChannels = 1;
        this.processor = this.audioContext.createScriptProcessor(bufferSize, numberOfInputChannels, numberOfOutputChannels);

        // Connect nodes
        source.connect(this.processor);
        this.processor.connect(this.analyser);

        // Handle audio processing
        this.processor.onaudioprocess = (event) => {
            const inputBuffer = event.inputBuffer;
            const channelData = inputBuffer.getChannelData(0); // Mono audio

            // Convert float samples (-1.0 to 1.0) to PCM 16-bit
            const pcmData = this.floatToPCM(channelData);

            // Send PCM 16-bit data as ArrayBuffer
            if (this.broadcasterSocket && this.broadcasterSocket.readyState === WebSocket.OPEN) {
                this.broadcasterSocket.send(pcmData.buffer);
                console.log(`Sent PCM audio chunk of size: ${pcmData.length * 2} bytes.`);
                console.log('First 10 bytes of sent data:', new Uint8Array(pcmData.buffer.slice(0, 10)));
            }
        };

        console.log('Audio processor set up for PCM 16-bit broadcasting.');
    }

    // Convert float audio samples to PCM 16-bit
    floatToPCM(floatSamples) {
        const pcmSamples = new Int16Array(floatSamples.length);
        for (let i = 0; i < floatSamples.length; i++) {
            let s = Math.max(-1, Math.min(1, floatSamples[i]));
            pcmSamples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcmSamples;
    }

    // Start listening for incoming PCM 16-bit audio
    async startListening() {
        try {
            this.updateUIState('connecting');
            console.log('Starting listening...');

            // Initialize AudioContext
            await this.initAudioContext();

            // Create WebSocket connection
            const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
            this.listenerSocket = new WebSocket(`${wsProtocol}${window.location.host}/listen`);
            this.listenerSocket.binaryType = 'arraybuffer';

            // Setup WebSocket event handlers
            this.listenerSocket.onopen = () => {
                console.log('Listener WebSocket connection opened.');
                this.updateUIState('listening');
                this.visualize();
            };

            this.listenerSocket.onmessage = async (event) => {
                // Log the type of incoming data
                console.log('Received data type:', typeof event.data);
                console.log('Instance of event.data:', event.data instanceof ArrayBuffer ? 'ArrayBuffer' : typeof event.data);
                
                if (event.data instanceof ArrayBuffer) {
                    console.log(`Received PCM audio chunk of size: ${event.data.byteLength} bytes.`);
                    
                    // Log the first few bytes for inspection
                    const bytes = new Uint8Array(event.data);
                    console.log('First 10 bytes of received data:', bytes.slice(0, 10));
                    
                    try {
                        // Convert PCM 16-bit ArrayBuffer to Float32Array
                        const floatData = this.pcmToFloat(new Int16Array(event.data));

                        // Create AudioBuffer
                        const audioBuffer = this.audioContext.createBuffer(1, floatData.length, this.audioContext.sampleRate);
                        audioBuffer.copyToChannel(floatData, 0);

                        // Create BufferSource for playback
                        const bufferSource = this.audioContext.createBufferSource();
                        bufferSource.buffer = audioBuffer;
                        bufferSource.connect(this.analyser);
                        bufferSource.start();
                        console.log('Played received PCM audio chunk.');

                        // Enqueue for visualization
                        this.audioBufferQueue.push(floatData);
                        if (!this.isProcessingQueue) {
                            this.isProcessingQueue = true;
                            while (this.audioBufferQueue.length > 0) {
                                const chunk = this.audioBufferQueue.shift();
                                this.visualizeChunk(chunk);
                            }
                            this.isProcessingQueue = false;
                        }
                    } catch (error) {
                        console.error('Error processing received PCM audio data:', error);
                    }
                } else if (typeof event.data === 'string') {
                    console.log('Received string data:', event.data);
                    // Handle potential JSON messages (e.g., MIME type info)
                    try {
                        const message = JSON.parse(event.data);
                        if (message.mimeType) {
                            console.log('Received MIME type from broadcaster:', message.mimeType);
                            // Optionally, adjust listener settings based on MIME type
                        }
                    } catch (e) {
                        console.warn('Received non-JSON message:', event.data);
                    }
                } else {
                    console.warn('Received unknown data type:', typeof event.data);
                }
            };

            this.listenerSocket.onerror = (error) => {
                console.error('Listener WebSocket error:', error);
                this.handleError(error);
            };

            this.listenerSocket.onclose = () => {
                console.log('Listener WebSocket connection closed.');
                if (this.animationId) {
                    cancelAnimationFrame(this.animationId);
                }
                this.stopStreaming();
            };

        } catch (error) {
            console.error('Listening setup error:', error);
            this.handleError(error);
        }
    }

    // Convert PCM 16-bit samples to Float32Array
    pcmToFloat(pcmSamples) {
        const floatSamples = new Float32Array(pcmSamples.length);
        for (let i = 0; i < pcmSamples.length; i++) {
            floatSamples[i] = pcmSamples[i] / 0x7FFF;
        }
        return floatSamples;
    }

    // Visualize a single chunk of audio data
    visualizeChunk(chunk) {
        if (!this.analyser || !this.dataArray) {
            console.warn('AnalyserNode or dataArray not initialized.');
            return;
        }
        // Here, you can process the chunk for visualization if needed
        // For simplicity, we'll skip detailed per-chunk visualization
    }

    // Handle errors by updating the UI and stopping streaming
    handleError(error) {
        let message = 'An error occurred.';
        
        if (error.name === 'NotAllowedError') {
            message = 'Microphone access denied. Please check permissions.';
        } else if (error.name === 'NotFoundError') {
            message = 'No microphone found. Please check your audio input devices.';
        } else if (error.name === 'NotReadableError') {
            message = 'Could not access microphone. Is it being used by another application?';
        } else if (error.message && error.message.includes('No compatible audio codec found')) {
            message = 'Your browser does not support any compatible audio codecs. ' +
                     'Please try using a different browser (Chrome or Firefox recommended).';
            console.log('MediaRecorder Support Info:', {
                mediaRecorderExists: typeof MediaRecorder !== 'undefined',
                isTypeSupported: typeof MediaRecorder?.isTypeSupported === 'function'
            });
        } else if (typeof error === 'string') {
            message = error;
        }

        statusDiv.textContent = message;
        this.stopStreaming();
    }

    // Stop broadcasting or listening, close WebSocket connections, and reset UI
    stopStreaming() {
        console.log('Stopping streaming...');
        // Disconnect processor
        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
            this.processor = null;
            console.log('Disconnected audio processor.');
        }

        // Stop media stream tracks
        if (this.stream) {
            console.log('Stopping media stream tracks...');
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        // Close WebSocket connections
        if (this.broadcasterSocket && this.broadcasterSocket.readyState === WebSocket.OPEN) {
            console.log('Closing broadcaster WebSocket connection...');
            this.broadcasterSocket.close();
        }
        if (this.listenerSocket && this.listenerSocket.readyState === WebSocket.OPEN) {
            console.log('Closing listener WebSocket connection...');
            this.listenerSocket.close();
        }

        // Stop visualization
        if (this.animationId) {
            console.log('Cancelling animation frame...');
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        // Reset state
        this.audioBufferQueue = [];
        this.isProcessingQueue = false;
        
        this.updateUIState('stopped');
    }

    // Update the UI based on the current state
    updateUIState(state) {
        console.log(`Updating UI state to: ${state}`);
        switch (state) {
            case 'connecting':
                broadcastBtn.disabled = true;
                listenBtn.disabled = true;
                stopBtn.disabled = false;
                statusDiv.textContent = 'Connecting...';
                break;
            case 'broadcasting':
                statusDiv.textContent = 'Broadcasting PCM 16-bit audio...';
                break;
            case 'listening':
                statusDiv.textContent = 'Listening...';
                break;
            case 'stopped':
                broadcastBtn.disabled = false;
                listenBtn.disabled = false;
                stopBtn.disabled = true;
                statusDiv.textContent = 'Stopped';
                break;
        }
    }
}

// Initialize manager and set up event listeners
const audioManager = new AudioStreamManager();

broadcastBtn.addEventListener('click', () => audioManager.startBroadcasting());
listenBtn.addEventListener('click', () => audioManager.startListening());
stopBtn.addEventListener('click', () => audioManager.stopStreaming());

// Function to check supported codecs (for debugging)
function checkSupportedCodecs() {
    const codecs = [
        "audio/webm; codecs=opus",
        "audio/ogg; codecs=opus",
        "audio/webm",
        "audio/ogg",
        "audio/mpeg", // For broader support
    ];

    codecs.forEach(codec => {
        if (MediaRecorder.isTypeSupported(codec)) {
            console.log(`${codec} is supported.`);
        } else {
            console.log(`${codec} is NOT supported.`);
        }
    });
}

// Call the function during initialization
document.addEventListener('DOMContentLoaded', () => {
    checkSupportedCodecs();
});
