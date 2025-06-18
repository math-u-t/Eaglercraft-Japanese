window.initializeVoiceClient = () => {
  class VoicePeer {
    constructor(client, peerId, peerConnection, initiator) {
      this.client = client;
      this.peerId = peerId;
      this.peerConnection = peerConnection;
      this.rawStream = null;

      // ICE Candidate handler
      this.peerConnection.addEventListener("icecandidate", event => {
        if (event.candidate) {
          const candidate = {
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            candidate: event.candidate.candidate
          };
          this.client.iceCandidateHandler(this.peerId, JSON.stringify(candidate));
        }
      });

      // Track handler
      this.peerConnection.addEventListener("track", event => {
        this.rawStream = event.streams[0];
        const audio = new Audio();
        audio.autoplay = true;
        audio.muted = true;
        audio.onended = () => audio.remove();
        audio.srcObject = this.rawStream;
        this.client.peerTrackHandler(this.peerId, this.rawStream);
      });

      // Add local media stream
      this.peerConnection.addStream(this.client.localMediaStream.stream);

      // Initiator: create offer
      if (initiator) {
        this.peerConnection.createOffer().then(offer => {
          this.peerConnection.setLocalDescription(offer, () => {
            this.client.descriptionHandler(this.peerId, JSON.stringify(offer));
            if (this.client.peerStateInitial !== 1) this.client.peerStateInitial = 1;
          }, err => {
            console.error(`Failed to set local description for "${this.peerId}"!`, err);
            if (this.client.peerStateInitial === 2) this.client.peerStateInitial = 0;
            this.client.signalDisconnect(this.peerId);
          });
        }).catch(err => {
          console.error(`Failed to create offer for "${this.peerId}"!`, err);
          if (this.client.peerStateInitial === 2) this.client.peerStateInitial = 0;
          this.client.signalDisconnect(this.peerId);
        });
      }

      // Connection state change
      this.peerConnection.addEventListener("connectionstatechange", () => {
        switch (this.peerConnection.connectionState) {
          case "disconnected":
            this.client.signalDisconnect(this.peerId);
            break;
          case "connected":
            if (this.client.peerState !== 1) this.client.peerState = 1;
            break;
          case "failed":
            if (this.client.peerState === 2) this.client.peerState = 0;
            this.client.signalDisconnect(this.peerId);
            break;
        }
      });
    }

    disconnect() {
      this.peerConnection.close();
    }

    mute(mute) {
      this.rawStream?.getAudioTracks()[0].enabled = !mute;
    }

    setRemoteDescription(desc) {
      try {
        const sdp = JSON.parse(desc);
        this.peerConnection.setRemoteDescription(sdp, () => {
          if (sdp.type === "offer") {
            this.peerConnection.createAnswer().then(answer => {
              this.peerConnection.setLocalDescription(answer, () => {
                this.client.descriptionHandler(this.peerId, JSON.stringify(answer));
                if (this.client.peerStateDesc !== 1) this.client.peerStateDesc = 1;
              }).catch(err => {
                console.error(`Failed to set local description for "${this.peerId}"!`, err);
                if (this.client.peerStateDesc === 2) this.client.peerStateDesc = 0;
                this.client.signalDisconnect(this.peerId);
              });
            }).catch(err => {
              console.error(`Failed to create answer for "${this.peerId}"!`, err);
              if (this.client.peerStateDesc === 2) this.client.peerStateDesc = 0;
              this.client.signalDisconnect(this.peerId);
            });
          }
        }, err => {
          console.error(`Failed to set remote description for "${this.peerId}"!`, err);
          if (this.client.peerStateDesc === 2) this.client.peerStateDesc = 0;
          this.client.signalDisconnect(this.peerId);
        });
      } catch (e) {
        console.error(`Failed to parse remote description for "${this.peerId}"!`, e);
        if (this.client.peerStateDesc === 2) this.client.peerStateDesc = 0;
        this.client.signalDisconnect(this.peerId);
      }
    }

    addICECandidate(candidateStr) {
      try {
        const candidate = new RTCIceCandidate(JSON.parse(candidateStr));
        this.peerConnection.addIceCandidate(candidate);
        if (this.client.peerStateIce !== 1) this.client.peerStateIce = 1;
      } catch (e) {
        console.error(`Failed to parse ice candidate for "${this.peerId}"!`, e);
        if (this.client.peerStateIce === 2) this.client.peerStateIce = 0;
        this.client.signalDisconnect(this.peerId);
      }
    }
  }

  class VoiceClient {
    constructor() {
      this.ICEServers = [];
      this.hasInit = false;
      this.peerList = new Map();

      this.peerState = 2;
      this.peerStateConnect = 2;
      this.peerStateInitial = 2;
      this.peerStateDesc = 2;
      this.peerStateIce = 2;

      this.microphoneVolumeAudioContext = null;
      this.localMediaStream = null;
      this.localRawMediaStream = null;
      this.localMediaStreamGain = null;

      this.iceCandidateHandler = null;
      this.descriptionHandler = null;
      this.peerTrackHandler = null;
      this.peerDisconnectHandler = null;
    }

    voiceClientSupported() {
      return typeof window.RTCPeerConnection !== "undefined" &&
             typeof navigator.mediaDevices !== "undefined" &&
             typeof navigator.mediaDevices.getUserMedia !== "undefined";
    }

    setICEServers(servers) {
      this.ICEServers = servers.map(s => {
        const parts = s.split(";");
        if (parts.length === 1) return { urls: parts[0] };
        if (parts.length === 3) return { urls: parts[0], username: parts[1], credential: parts[2] };
        return null;
      }).filter(Boolean);
    }

    setICECandidateHandler(handler) { this.iceCandidateHandler = handler; }
    setDescriptionHandler(handler) { this.descriptionHandler = handler; }
    setPeerTrackHandler(handler) { this.peerTrackHandler = handler; }
    setPeerDisconnectHandler(handler) { this.peerDisconnectHandler = handler; }

    activateVoice(enable) {
      if (this.hasInit) {
        this.localRawMediaStream.getAudioTracks()[0].enabled = enable;
      }
    }

    initializeDevices() {
      if (this.hasInit) {
        this.readyState = 1;
        return;
      }

      navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
        this.microphoneVolumeAudioContext = new AudioContext();
        this.localRawMediaStream = stream;
        stream.getAudioTracks()[0].enabled = false;

        this.localMediaStream = this.microphoneVolumeAudioContext.createMediaStreamDestination();
        this.localMediaStreamGain = this.microphoneVolumeAudioContext.createGain();
        this.microphoneVolumeAudioContext.createMediaStreamSource(stream)
          .connect(this.localMediaStreamGain)
          .connect(this.localMediaStream);
        this.localMediaStreamGain.gain.value = 1;

        this.readyState = 1;
        this.hasInit = true;
      }).catch(() => {
        this.readyState = -1;
      });
    }

    setMicVolume(volume) {
      if (!this.hasInit) return;
      if (volume > 0.5) volume = 0.5 + 2 * (volume - 0.5);
      if (volume > 1.5) volume = 1.5;
      if (volume < 0) volume = 0;
      this.localMediaStreamGain.gain.value = 2 * volume;
    }

    resetPeerStates() {
      this.peerState = this.peerStateConnect = this.peerStateInitial = this.peerStateDesc = this.peerStateIce = 2;
    }

    getPeerState() { return this.peerState; }
    getPeerStateConnect() { return this.peerStateConnect; }
    getPeerStateInitial() { return this.peerStateInitial; }
    getPeerStateDesc() { return this.peerStateDesc; }
    getPeerStateIce() { return this.peerStateIce; }
    getReadyState() { return this.readyState; }

    signalConnect(peerId, initiator) {
      if (!this.hasInit) this.initializeDevices();
      try {
        const pc = new RTCPeerConnection({ iceServers: this.ICEServers });
        const peer = new VoicePeer(this, peerId, pc, initiator);
        this.peerList.set(peerId, peer);
        if (this.peerStateConnect !== 1) this.peerStateConnect = 1;
      } catch (e) {
        if (this.peerStateConnect === 2) this.peerStateConnect = 0;
      }
    }

    signalDescription(peerId, description) {
      const peer = this.peerList.get(peerId);
      if (peer) peer.setRemoteDescription(description);
    }

    signalICECandidate(peerId, candidate) {
      const peer = this.peerList.get(peerId);
      if (peer) peer.addICECandidate(candidate);
    }

    mutePeer(peerId, mute) {
      const peer = this.peerList.get(peerId);
      if (peer) peer.mute(mute);
    }

    signalDisconnect(peerId, reason) {
      const peer = this.peerList.get(peerId);
      if (peer) {
        this.peerList.delete(peerId);
        try { peer.disconnect(); } catch {}
        this.peerDisconnectHandler(peerId, reason);
      }
    }
  }

  window.constructVoiceClient = () => new VoiceClient();
};

window.startVoiceClient = () => {
  if (typeof window.constructVoiceClient !== "function") {
    window.initializeVoiceClient();
  }
  return window.constructVoiceClient();
};