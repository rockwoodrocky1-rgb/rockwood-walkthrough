# Primary implementation references

Consulted October 12, 2026. Recheck API and browser documentation during implementation.

- MDN, getUserMedia: permissions, secure contexts, camera/microphone access.
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN, MediaRecorder: recording streams and MIME feature detection.
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- W3C, MediaStream Recording: timeslice chunks need not be independently playable; complete recordings combine all chunks.
  https://www.w3.org/TR/mediastream-recording/
- MDN, dataavailable: timing and mobile/browser interruption considerations.
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/dataavailable_event
- MDN, SpeechRecognition: limited availability and potential server-based processing.
  https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- OpenAI, file transcription: supported formats, model-specific output behavior, and Whisper segment timestamps.
  https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI, structured model outputs: schema-constrained report generation and validation.
  https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI, GPT-4.1 mini: image inputs, Responses API, and structured output support.
  https://developers.openai.com/api/docs/models/gpt-4.1-mini
- Vercel, function limits: the documented request/response payload limit is 4.5 MB; app-level limits should leave overhead and be checked against the actual host.
  https://vercel.com/docs/functions/limitations

The colors were sampled directly from the user-supplied screenshot, not obtained from a public brand manual. All workflow and UI choices are proposed requirements for this prototype, not statements about CompanyCam or Rockwood's actual operations.
