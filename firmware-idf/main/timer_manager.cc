/**
 * Timer Manager Implementation
 */

#include "timer_manager.h"
#include <esp_log.h>
#include <esp_timer.h>
#include <cstring>
#include <algorithm>

#define TAG "TimerManager"

TimerManager& TimerManager::GetInstance() {
    static TimerManager instance;
    return instance;
}

TimerManager::TimerManager() : on_timer_expired_(nullptr), initialized_(false) {
    // Initialize all timer slots
    for (int i = 0; i < MAX_TIMERS; i++) {
        timers_[i].state = TimerState::IDLE;
    }
}

void TimerManager::Initialize(TimerExpiredCallback callback) {
    on_timer_expired_ = callback;
    initialized_ = true;
    ESP_LOGI(TAG, "Timer manager initialized with callback");
}

bool TimerManager::SetTimer(const char* name, uint32_t duration_seconds, const char* reminder_phrase) {
    if (!initialized_) {
        ESP_LOGE(TAG, "Timer manager not initialized");
        return false;
    }

    // Check if timer with same name exists
    Timer* existing = FindTimerByName(name);
    if (existing && existing->state == TimerState::RUNNING) {
        ESP_LOGW(TAG, "Timer '%s' already exists, updating", name);
        // Update existing timer
        existing->duration_seconds = duration_seconds;
        existing->remaining_seconds = duration_seconds;
        existing->start_time_ms = esp_timer_get_time() / 1000;
        strncpy(existing->reminder_phrase, reminder_phrase, MAX_REMINDER_PHRASE_LEN - 1);
        existing->reminder_phrase[MAX_REMINDER_PHRASE_LEN - 1] = '\0';
        return true;
    }

    // Find free slot
    Timer* slot = FindFreeSlot();
    if (!slot) {
        ESP_LOGE(TAG, "Max timers reached (%d)", MAX_TIMERS);
        return false;
    }

    // Set timer
    strncpy(slot->name, name, MAX_TIMER_NAME_LEN - 1);
    slot->name[MAX_TIMER_NAME_LEN - 1] = '\0';
    strncpy(slot->reminder_phrase, reminder_phrase, MAX_REMINDER_PHRASE_LEN - 1);
    slot->reminder_phrase[MAX_REMINDER_PHRASE_LEN - 1] = '\0';
    slot->duration_seconds = duration_seconds;
    slot->remaining_seconds = duration_seconds;
    slot->start_time_ms = esp_timer_get_time() / 1000;
    slot->state = TimerState::RUNNING;

    // Clear any existing audio
    if (slot->reminder_audio) {
        free(slot->reminder_audio);
        slot->reminder_audio = nullptr;
        slot->reminder_audio_size = 0;
    }

    ESP_LOGI(TAG, "Timer '%s' set for %lu seconds", name, (unsigned long)duration_seconds);
    return true;
}

bool TimerManager::CancelTimer(const char* name) {
    Timer* timer = FindTimerByName(name);
    if (!timer || timer->state == TimerState::IDLE) {
        ESP_LOGW(TAG, "Timer '%s' not found", name);
        return false;
    }

    timer->state = TimerState::CANCELLED;

    // Free audio buffer
    if (timer->reminder_audio) {
        free(timer->reminder_audio);
        timer->reminder_audio = nullptr;
        timer->reminder_audio_size = 0;
    }

    ESP_LOGI(TAG, "Timer '%s' cancelled", name);

    // Mark as idle after a short delay (or immediately)
    timer->state = TimerState::IDLE;
    return true;
}

bool TimerManager::SetTimerAudio(const char* name, const uint8_t* audio_data, size_t audio_size) {
    Timer* timer = FindTimerByName(name);
    if (!timer || timer->state != TimerState::RUNNING) {
        ESP_LOGW(TAG, "Timer '%s' not found or not running", name);
        return false;
    }

    if (audio_size > MAX_REMINDER_AUDIO_SIZE) {
        ESP_LOGE(TAG, "Audio too large: %zu > %d", audio_size, MAX_REMINDER_AUDIO_SIZE);
        return false;
    }

    // Free existing audio if any
    if (timer->reminder_audio) {
        free(timer->reminder_audio);
    }

    // Allocate and copy audio
    timer->reminder_audio = (uint8_t*)malloc(audio_size);
    if (!timer->reminder_audio) {
        ESP_LOGE(TAG, "Failed to allocate %zu bytes for timer audio", audio_size);
        timer->reminder_audio_size = 0;
        return false;
    }

    memcpy(timer->reminder_audio, audio_data, audio_size);
    timer->reminder_audio_size = audio_size;

    ESP_LOGI(TAG, "Timer '%s' audio set: %zu bytes", name, audio_size);
    return true;
}

std::vector<const Timer*> TimerManager::GetActiveTimers() const {
    std::vector<const Timer*> active;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].IsActive()) {
            active.push_back(&timers_[i]);
        }
    }
    return active;
}

const Timer* TimerManager::GetTimer(const char* name) const {
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].state != TimerState::IDLE &&
            strcmp(timers_[i].name, name) == 0) {
            return &timers_[i];
        }
    }
    return nullptr;
}

int TimerManager::GetActiveTimerCount() const {
    int count = 0;
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].IsActive()) {
            count++;
        }
    }
    return count;
}

void TimerManager::AcknowledgeTimer(const char* name) {
    Timer* timer = FindTimerByName(name);
    if (timer && timer->state == TimerState::EXPIRED) {
        timer->state = TimerState::IDLE;

        // Free audio buffer
        if (timer->reminder_audio) {
            free(timer->reminder_audio);
            timer->reminder_audio = nullptr;
            timer->reminder_audio_size = 0;
        }

        ESP_LOGI(TAG, "Timer '%s' acknowledged", name);
    }
}

void TimerManager::Update() {
    uint32_t now_ms = esp_timer_get_time() / 1000;

    for (int i = 0; i < MAX_TIMERS; i++) {
        Timer& timer = timers_[i];
        if (timer.state != TimerState::RUNNING) {
            continue;
        }

        // Calculate elapsed time
        uint32_t elapsed_ms = now_ms - timer.start_time_ms;
        uint32_t elapsed_sec = elapsed_ms / 1000;

        if (elapsed_sec >= timer.duration_seconds) {
            // Timer expired!
            timer.remaining_seconds = 0;
            timer.state = TimerState::EXPIRED;

            ESP_LOGI(TAG, "Timer '%s' expired!", timer.name);

            if (on_timer_expired_) {
                on_timer_expired_(timer);
            }
        } else {
            timer.remaining_seconds = timer.duration_seconds - elapsed_sec;
        }
    }
}

const Timer* TimerManager::GetNextExpiringTimer() const {
    const Timer* next = nullptr;
    uint32_t min_remaining = UINT32_MAX;

    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].state == TimerState::RUNNING &&
            timers_[i].remaining_seconds < min_remaining) {
            min_remaining = timers_[i].remaining_seconds;
            next = &timers_[i];
        }
    }

    return next;
}

void TimerManager::ClearAll() {
    for (int i = 0; i < MAX_TIMERS; i++) {
        timers_[i].state = TimerState::IDLE;
        if (timers_[i].reminder_audio) {
            free(timers_[i].reminder_audio);
            timers_[i].reminder_audio = nullptr;
            timers_[i].reminder_audio_size = 0;
        }
    }
    ESP_LOGI(TAG, "All timers cleared");
}

Timer* TimerManager::FindTimerByName(const char* name) {
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].state != TimerState::IDLE &&
            strcmp(timers_[i].name, name) == 0) {
            return &timers_[i];
        }
    }
    return nullptr;
}

Timer* TimerManager::FindFreeSlot() {
    for (int i = 0; i < MAX_TIMERS; i++) {
        if (timers_[i].state == TimerState::IDLE) {
            return &timers_[i];
        }
    }
    return nullptr;
}
