// tuner-audio-processor.js

/**
 * AudioWorkletProcessor for performing autocorrelation-based pitch detection.
 * This runs in a separate thread, offloading heavy audio processing from the main UI thread.
 */
class TunerAudioProcessor extends AudioWorkletProcessor {
    // No custom parameters needed for now.
    static get parameterDescriptors() {
        return [];
    }

    constructor() {
        super();
        this.sampleRate = 0; // Will be initialized on first process call
        this.buffer = new Float32Array(2048); // Fixed buffer size for autocorrelation
        this.bufferIndex = 0; // Current fill level of the buffer

        // Tuner specific constants - these should ideally be configurable from main thread
        // but are hardcoded here for simplicity and consistency with main script's expectations.
        this.MIN_RMS = 0.005; // Minimum RMS to consider valid audio
        const GUITAR_STRINGS = [ // These frequencies define the search range for the tuner
            { name: "E2", freq: 82.41, midi: 40 },
            { name: "A2", freq: 110.00, midi: 45 },
            { name: "D3", freq: 146.83, midi: 50 },
            { name: "G3", freq: 196.00, midi: 55 },
            { name: "B3", freq: 246.94, midi: 59 },
            { name: "E4", freq: 329.63, midi: 64 }
        ];
        this.GUITAR_MIN_FREQ = GUITAR_STRINGS[0].freq * 0.9; // E2 slightly lower for wider detection
        this.GUITAR_MAX_FREQ = GUITAR_STRINGS[GUITAR_STRINGS.length - 1].freq * 1.1; // E4 slightly higher
    }

    /**
     * Processes input audio data. This method is called by the Web Audio API.
     * @param {Float32Array[][]} inputs - An array of input audio buffers.
     * @param {Float32Array[][]} outputs - An array of output audio buffers.
     * @param {object} parameters - Custom parameters if any.
     * @returns {boolean} - True to keep the processor alive.
     */
    process(inputs, outputs, parameters) {
        if (!this.sampleRate) {
            this.sampleRate = sampleRate; // `sampleRate` is globally available in AudioWorklet scope
        }

        const input = inputs[0]; // Get the first input (assuming mono)
        const output = outputs[0]; // Get the first output (for passthrough)

        if (input.length === 0 || input[0].length === 0) {
            // No input data, just passthrough silence
            if (output.length > 0) {
                for (let i = 0; i < output[0].length; i++) {
                    output[0][i] = 0;
                }
            }
            return true;
        }

        const inputChannelData = input[0];
        const outputChannelData = output[0];

        // Passthrough audio to the output (optional, but good for monitoring)
        for (let i = 0; i < inputChannelData.length; i++) {
            outputChannelData[i] = inputChannelData[i];
        }

        // Copy input data into our internal buffer for pitch detection
        const inputLength = inputChannelData.length;
        if (this.bufferIndex + inputLength <= this.buffer.length) {
            // If the input fits into the remaining buffer space, just append
            this.buffer.set(inputChannelData, this.bufferIndex);
            this.bufferIndex += inputLength;
        } else {
            // If the input overflows, shift existing data and append
            const overflow = (this.bufferIndex + inputLength) - this.buffer.length;
            this.buffer.copyWithin(0, overflow); // Shift data to the left
            this.buffer.set(inputChannelData, this.buffer.length - inputLength); // Append new data
            this.bufferIndex = this.buffer.length; // Buffer is full
        }

        // When the buffer is full (or regularly, if you prefer), perform pitch detection
        if (this.bufferIndex >= this.buffer.length) {
            this.autocorrelate(this.buffer, this.sampleRate);
            this.bufferIndex = 0; // Reset buffer index after processing
        }

        return true; // Keep the processor active
    }

    /**
     * Performs autocorrelation on the given audio buffer to find the fundamental frequency.
     * Posts the result back to the main thread via `this.port.postMessage`.
     * @param {Float32Array} buffer - The audio data buffer.
     * @param {number} sampleRate - The sample rate of the audio context.
     */
    autocorrelate(buffer, sampleRate) {
        const bufferLength = buffer.length;
        let rms = 0;
        for (let i = 0; i < bufferLength; i++) {
            let val = buffer[i];
            rms += val * val;
        }
        rms = Math.sqrt(rms / bufferLength);

        if (rms < this.MIN_RMS) {
            this.port.postMessage({ frequency: 0, confidence: 0 });
            return;
        }

        // Trim silence from beginning and end to improve accuracy
        let r1 = 0, r2 = bufferLength - 1, thres = 0.2; // threshold for trimming
        for (let i = 0; i < bufferLength / 2; i++) {
            if (Math.abs(buffer[i]) < thres) { r1 = i; break; }
        }
        for (let i = 1; i < bufferLength / 2; i++) {
            if (Math.abs(buffer[bufferLength - i]) < thres) { r2 = bufferLength - i; break; }
        }
        if (r1 >= r2) { r1 = 0; r2 = bufferLength - 1; } // Reset if trimming fails for short sounds

        const trimmedBuffer = buffer.slice(r1, r2 + 1);
        const trimmedBufferSize = trimmedBuffer.length;

        if (trimmedBufferSize < 100) { // Too short to reliably correlate
            this.port.postMessage({ frequency: 0, confidence: 0 });
            return;
        }

        const acf = new Array(trimmedBufferSize).fill(0);
        for (let i = 0; i < trimmedBufferSize; i++) {
            for (let j = 0; j < trimmedBufferSize - i; j++) {
                acf[i] = acf[i] + trimmedBuffer[j] * trimmedBuffer[j + i];
            }
        }

        let d = 0; while (d < trimmedBufferSize - 1 && acf[d] > acf[d + 1]) d++; // Find first positive slope

        let maxval = -1, maxpos = -1;
        
        const minPeriod = Math.floor(sampleRate / this.GUITAR_MAX_FREQ);
        const maxPeriod = Math.floor(sampleRate / this.GUITAR_MIN_FREQ);

        for (let i = minPeriod; i <= maxPeriod && i < trimmedBufferSize; i++) {
            if (acf[i] > maxval) {
                maxval = acf[i];
                maxpos = i;
            }
        }

        if (maxpos === -1 || maxpos === 0) { // No peak found or peak at 0
            this.port.postMessage({ frequency: 0, confidence: 0 });
            return;
        }

        // Parabolic interpolation to find sub-sample peak
        let T0 = maxpos;
        let x0 = T0 < 1 ? T0 : T0 - 1;
        let x2 = T0 + 1 < trimmedBufferSize ? T0 + 1 : T0;
        if (x0 === T0) x0++;
        if (x2 === T0) x2--;
        
        // Check for valid indices
        if (x0 < 0 || x2 >= trimmedBufferSize) { // If interpolation indices are out of bounds
             this.port.postMessage({ frequency: sampleRate / T0, confidence: (maxval > 0) ? (maxval / acf[0]) : 0 });
             return;
        }
        if (acf[x0] === 0 || acf[x2] === 0) { // Avoid division by zero
            this.port.postMessage({ frequency: sampleRate / T0, confidence: (maxval > 0) ? (maxval / acf[0]) : 0 });
            return;
        }

        const a = (acf[x0] + acf[x2] - 2 * acf[T0]) / 2;
        const b = (acf[x2] - acf[x0]) / 2;
        if (a) {
            T0 -= b / (2 * a);
        }
        const frequency = sampleRate / T0;
        const confidence = (maxval > 0) ? (maxval / acf[0]) : 0; // Relative to 0-lag correlation

        this.port.postMessage({ frequency: frequency, confidence: confidence });
    }
}

registerProcessor('tuner-audio-processor', TunerAudioProcessor);