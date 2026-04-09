/**
 * Timer Manager for Chef AI
 *
 * Manages multiple kitchen timers with audio reminders.
 * Supports up to 5 concurrent timers with cached reminder audio.
 */

#ifndef TIMER_MANAGER_H
#define TIMER_MANAGER_H

#include <string>
#include <vector>
#include <functional>
#include <memory>
#include <cstdint>

#define MAX_TIMERS 5
#define MAX_TIMER_NAME_LEN 32
#define MAX_REMINDER_PHRASE_LEN 128
#define MAX_REMINDER_AUDIO_SIZE (50 * 1024)  // 50KB max per timer audio

/**
 * Timer state
 */
enum class TimerState {
    IDLE,       // Timer not set
    RUNNING,    // Timer counting down
    EXPIRED,    // Timer finished, waiting for acknowledgment
    CANCELLED   // Timer was cancelled
};

/**
 * Single timer entry
 */
struct Timer {
    char name[MAX_TIMER_NAME_LEN];
    char reminder_phrase[MAX_REMINDER_PHRASE_LEN];
    uint32_t duration_seconds;      // Total duration
    uint32_t remaining_seconds;     // Seconds remaining
    uint32_t start_time_ms;         // Start time (millis)
    TimerState state;

    // Cached reminder audio (Opus encoded)
    uint8_t* reminder_audio;
    size_t reminder_audio_size;

    Timer() : duration_seconds(0), remaining_seconds(0), start_time_ms(0),
              state(TimerState::IDLE), reminder_audio(nullptr), reminder_audio_size(0) {
        name[0] = '\0';
        reminder_phrase[0] = '\0';
    }

    ~Timer() {
        if (reminder_audio) {
            free(reminder_audio);
            reminder_audio = nullptr;
        }
    }

    bool IsActive() const {
        return state == TimerState::RUNNING || state == TimerState::EXPIRED;
    }
};

/**
 * Timer expiration callback
 */
using TimerExpiredCallback = std::function<void(const Timer& timer)>;

/**
 * Timer Manager class
 */
class TimerManager {
public:
    static TimerManager& GetInstance();

    /**
     * Initialize timer manager
     * @param callback Function to call when a timer expires
     */
    void Initialize(TimerExpiredCallback callback);

    /**
     * Set a new timer
     * @param name Timer name (e.g., "eggs", "pasta")
     * @param duration_seconds Duration in seconds
     * @param reminder_phrase What to say when timer expires
     * @return true if timer was set, false if max timers reached
     */
    bool SetTimer(const char* name, uint32_t duration_seconds, const char* reminder_phrase);

    /**
     * Cancel a timer by name
     * @param name Timer name to cancel
     * @return true if timer was found and cancelled
     */
    bool CancelTimer(const char* name);

    /**
     * Set reminder audio for a timer
     * @param name Timer name
     * @param audio_data Opus-encoded audio data
     * @param audio_size Size of audio data
     * @return true if timer found and audio set
     */
    bool SetTimerAudio(const char* name, const uint8_t* audio_data, size_t audio_size);

    /**
     * Get all active timers
     * @return Vector of active timers
     */
    std::vector<const Timer*> GetActiveTimers() const;

    /**
     * Get timer by name
     * @param name Timer name
     * @return Pointer to timer or nullptr if not found
     */
    const Timer* GetTimer(const char* name) const;

    /**
     * Get number of active timers
     */
    int GetActiveTimerCount() const;

    /**
     * Acknowledge an expired timer (clears the EXPIRED state)
     * @param name Timer name
     */
    void AcknowledgeTimer(const char* name);

    /**
     * Update timers (call periodically from main loop)
     * Checks for expired timers and triggers callbacks
     */
    void Update();

    /**
     * Get the timer that will expire soonest
     * @return Pointer to timer or nullptr if no active timers
     */
    const Timer* GetNextExpiringTimer() const;

    /**
     * Clear all timers
     */
    void ClearAll();

private:
    TimerManager();
    ~TimerManager() = default;
    TimerManager(const TimerManager&) = delete;
    TimerManager& operator=(const TimerManager&) = delete;

    Timer* FindTimerByName(const char* name);
    Timer* FindFreeSlot();

    Timer timers_[MAX_TIMERS];
    TimerExpiredCallback on_timer_expired_;
    bool initialized_;
};

#endif // TIMER_MANAGER_H
