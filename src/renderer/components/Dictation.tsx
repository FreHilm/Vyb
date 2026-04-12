import { useEffect, useRef, useState, useCallback } from 'react';

interface UseDictationOptions {
  lang: string;
  mode: 'toggle' | 'hold';
  onTranscript: (text: string) => void;
}

export function useDictation({ lang, mode, onTranscript }: UseDictationOptions) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Use Whisper-compatible approach: record audio, then use IPC to transcribe
  // But since we want real-time, use the native macOS `say` / dictation via execSync
  // Actually, let's try the Web Speech API with a workaround for Electron

  const startListening = useCallback(async () => {
    if (listening) return;
    setListening(true);
    setInterim('');

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        chunksRef.current = [];

        // Send to main process for transcription
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        );

        try {
          const text = await window.api.transcribeAudio(base64, lang);
          if (text && text.trim()) {
            onTranscript(text.trim());
          }
        } catch (err) {
          console.error('Transcription failed:', err);
        }
        setInterim('');
      };

      mediaRecorder.start();
      setInterim('Recording...');
    } catch (err) {
      console.error('Microphone access failed:', err);
      setListening(false);
    }
  }, [listening, lang, onTranscript]);

  const stopListening = useCallback(() => {
    if (!listening) return;
    setListening(false);
    setInterim('Transcribing...');

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [listening]);

  const toggleListening = useCallback(() => {
    if (listening) stopListening();
    else startListening();
  }, [listening, startListening, stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return {
    listening,
    interim,
    supported: true, // MediaRecorder is always available
    startListening,
    stopListening,
    toggleListening,
  };
}
