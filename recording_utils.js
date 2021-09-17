/**
 * @type {AudioContext | undefined}
 */
let audioContext;

function getAudioContext() {
  return (audioContext =
    audioContext || new AudioContext());
}

/**
 * @typedef {Omit<AudioWorkletNode, 'parameters'> & {
 *   parameters: Map<'isRecording' | 'bufferSize', AudioParam>
 * }} TAudioWorkletNode
 */

/**
 * @typedef {{
 *  channelCount: number;
 *  onData: (audioChannels: Float32Array[]) => void;
 *  onFinish: () => void;
 * }} PcmRecorderNodeOptions
 */

/**
 * @type {Promise<void> | undefined}
 */
let recorderWorkletProcessorPromise;
/**
 * @param {PcmRecorderNodeOptions} options
 * @returns {Promise<{ recorderNode: TAudioWorkletNode; stop: () => void }>}
 */
async function createAudioWorkletPcmRecorderNode({ onData, onFinish }) {
  const audioContext = getAudioContext();
  recorderWorkletProcessorPromise =
    recorderWorkletProcessorPromise ||
    audioContext.audioWorklet.addModule('recorderWorkletProcessor.js');
  await recorderWorkletProcessorPromise;
  const recorderNode = /** @type {TAudioWorkletNode} */ (
    new AudioWorkletNode(audioContext, 'recorder-worklet', {
      parameterData: {
        bufferSize: 1024,
      },
    })
  );
  recorderNode.port.onmessage = (e) => {
    if (e.data.eventType === 'data') {
      /**
       * @type {Float32Array[]}
       */
      const audioChannels = e.data.audioChannels;
      onData(audioChannels);
    }

    if (e.data.eventType === 'stop') {
      onFinish();
    }
  };
  const isRecordingParam = /** @type {AudioParam} */ (
    recorderNode.parameters.get('isRecording')
  );
  isRecordingParam.setValueAtTime(1, audioContext.currentTime);
  return {
    recorderNode,
    stop() {
      isRecordingParam.setValueAtTime(0, audioContext.currentTime);
    },
  };
}

/**
 * @param {PcmRecorderNodeOptions} options
 * @returns {{ recorderNode: ScriptProcessorNode; stop: () => void }}
 */
function createScriptProcessorPcmRecorderNode({
  channelCount,
  onData,
  onFinish,
}) {
  const audioContext = getAudioContext();
  const recorderNode = audioContext.createScriptProcessor(
    1024,
    channelCount,
    channelCount
  );
  // to be set by user if they want to stop recording before time limit reached
  let stopped = false;
  recorderNode.onaudioprocess = (e) => {
    const audioChannels = /** @type {void[]} */ (Array(channelCount))
      .fill()
      .map((_, i) => e.inputBuffer.getChannelData(i));
    onData(audioChannels);
    if (stopped) {
      onFinish();
    }
  };
  return {
    recorderNode,
    stop() {
      stopped = true;
    },
  };
}

/**
 * @param {(data: Float32Array) => void} onData
 * @param {boolean} [useScriptProcessorNode]
 * @returns {Promise<() => void>} stop
 */
async function captureAudio(onData, useScriptProcessorNode = false) {
  const channelCount = 1;
  const stream = await navigator.mediaDevices.getUserMedia({
    // TODO: support more recording configuration options
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints#properties_of_audio_tracks
    // autoGainControl, echoCancellation, latency, noiseSuppression, volume
    audio: { channelCount },
    video: false,
  });
  const audioContext = getAudioContext();
  const mediaStreamSourceNode = audioContext.createMediaStreamSource(stream);
  const recorderNodeFactory = useScriptProcessorNode
    ? createScriptProcessorPcmRecorderNode
    : createAudioWorkletPcmRecorderNode;
  if (useScriptProcessorNode) {
    console.log('Using ScriptProcessorNode');
  } else {
    console.log('Using AudioWorkletNode');
  }
  const { recorderNode, stop } = await recorderNodeFactory({
    channelCount,
    onData: ([channelData]) => onData(channelData),
    onFinish,
  });
  mediaStreamSourceNode.connect(recorderNode);
  recorderNode.connect(audioContext.destination);

  let finished = false;
  function onFinish() {
    if (finished) {
      return;
    }

    // clean up
    const tracks = stream.getTracks();
    for (const track of tracks) {
      track.stop();
    }
    recorderNode.disconnect(audioContext.destination);
    mediaStreamSourceNode.disconnect(recorderNode);
    finished = true;
  }

  return stop;
}
