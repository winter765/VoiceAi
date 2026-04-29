#ifndef ELATO_PROTOCOL_H
#define ELATO_PROTOCOL_H

#include "protocol.h"
#include <memory>
#include <string>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

class WebSocket;

// Event bits for ElatoProtocol
#define ELATO_PROTOCOL_SERVER_AUTH_EVENT (1 << 0)

class ElatoProtocol : public Protocol {
public:
    ElatoProtocol();
    virtual ~ElatoProtocol();

    bool Start() override;
    bool OpenAudioChannel() override;
    void CloseAudioChannel(bool send_goodbye = true) override;
    bool IsAudioChannelOpened() const override;
    bool SendAudio(std::unique_ptr<AudioStreamPacket> packet) override;

    void SendWakeWordDetected(const std::string& wake_word) override;
    void SendStartListening(ListeningMode mode) override;
    void SendStopListening() override;
    void SendAbortSpeaking(AbortReason reason) override;

protected:
    bool SendText(const std::string& text) override;

private:
    std::unique_ptr<WebSocket> websocket_;
    EventGroupHandle_t event_group_handle_;

    // ElatoAI uses version 1 (raw Opus payload, no header)
    int version_ = 1;

    std::string GetHelloMessage();
    void ParseAuthMessage(const cJSON* root);
    void ParseServerMessage(const cJSON* root);

    // Chef AI: Timer and Recipe message handlers
    void ParseTimerSetMessage(const cJSON* root);
    void ParseTimerCancelMessage(const cJSON* root);
    void ParseTimerAudioMessage(const cJSON* root);
    void ParseRecipeSessionMessage(const cJSON* root);

    // System settings handlers
    void ParseSetTimezoneMessage(const cJSON* root);
};

#endif // ELATO_PROTOCOL_H
