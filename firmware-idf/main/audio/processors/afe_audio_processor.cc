#include "afe_audio_processor.h"
#include <esp_log.h>

#ifdef CONFIG_USE_SOFTWARE_AEC
#include <esp_ae_rate_cvt.h>

#define RATE_CVT_CFG(_src_rate, _dest_rate, _channel)        \
    (esp_ae_rate_cvt_cfg_t)                                  \
    {                                                        \
        .src_rate        = (uint32_t)(_src_rate),            \
        .dest_rate       = (uint32_t)(_dest_rate),           \
        .channel         = (uint8_t)(_channel),              \
        .bits_per_sample = ESP_AE_BIT16,                     \
        .complexity      = 2,                                \
        .perf_type       = ESP_AE_RATE_CVT_PERF_TYPE_SPEED,  \
    }
#endif

#define PROCESSOR_RUNNING 0x01

#define TAG "AfeAudioProcessor"

AfeAudioProcessor::AfeAudioProcessor()
    : afe_data_(nullptr) {
    event_group_ = xEventGroupCreate();
}

void AfeAudioProcessor::Initialize(AudioCodec* codec, int frame_duration_ms, srmodel_list_t* models_list) {
    codec_ = codec;
    frame_samples_ = frame_duration_ms * 16000 / 1000;

    // Pre-allocate output buffer capacity
    output_buffer_.reserve(frame_samples_);

#ifdef CONFIG_USE_SOFTWARE_AEC
    // Software AEC: force "MR" format (1 mic + 1 software reference)
    std::string input_format = "MR";
    ESP_LOGI(TAG, "Software AEC enabled, using input format: %s", input_format.c_str());
#else
    int ref_num = codec_->input_reference() ? 1 : 0;

    std::string input_format;
    for (int i = 0; i < codec_->input_channels() - ref_num; i++) {
        input_format.push_back('M');
    }
    for (int i = 0; i < ref_num; i++) {
        input_format.push_back('R');
    }
#endif

    srmodel_list_t *models;
    if (models_list == nullptr) {
        models = esp_srmodel_init("model");
    } else {
        models = models_list;
    }

    char* ns_model_name = esp_srmodel_filter(models, ESP_NSNET_PREFIX, NULL);
    char* vad_model_name = esp_srmodel_filter(models, ESP_VADN_PREFIX, NULL);

    afe_config_t* afe_config = afe_config_init(input_format.c_str(), NULL, AFE_TYPE_VC, AFE_MODE_HIGH_PERF);
    afe_config->aec_mode = AEC_MODE_VOIP_HIGH_PERF;
    afe_config->vad_mode = VAD_MODE_0;
    afe_config->vad_min_noise_ms = 100;
    if (vad_model_name != nullptr) {
        afe_config->vad_model_name = vad_model_name;
    }

    if (ns_model_name != nullptr) {
        afe_config->ns_init = true;
        afe_config->ns_model_name = ns_model_name;
        afe_config->afe_ns_mode = AFE_NS_MODE_NET;
    } else {
        afe_config->ns_init = false;
    }

    afe_config->agc_init = true;
    afe_config->agc_mode = AFE_AGC_MODE_WEBRTC;
    afe_config->agc_compression_gain_db = 9;   // Compression gain in dB
    afe_config->agc_target_level_dbfs = 3;     // Target level -3 dBFS
    afe_config->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;

#if defined(CONFIG_USE_DEVICE_AEC) || defined(CONFIG_USE_SOFTWARE_AEC)
    afe_config->aec_init = true;
    afe_config->vad_init = false;
    ESP_LOGI(TAG, "AEC enabled");
#else
    afe_config->aec_init = false;
    afe_config->vad_init = true;
#endif

    afe_iface_ = esp_afe_handle_from_config(afe_config);
    afe_data_ = afe_iface_->create_from_config(afe_config);

    xTaskCreate([](void* arg) {
        auto this_ = (AfeAudioProcessor*)arg;
        this_->AudioProcessorTask();
        vTaskDelete(NULL);
    }, "audio_communication", 4096, this, 3, NULL);
}

AfeAudioProcessor::~AfeAudioProcessor() {
    if (afe_data_ != nullptr) {
        afe_iface_->destroy(afe_data_);
    }
#ifdef CONFIG_USE_SOFTWARE_AEC
    if (reference_resampler_ != nullptr) {
        esp_ae_rate_cvt_close(reference_resampler_);
    }
#endif
    vEventGroupDelete(event_group_);
}

size_t AfeAudioProcessor::GetFeedSize() {
    if (afe_data_ == nullptr) {
        return 0;
    }
    return afe_iface_->get_feed_chunksize(afe_data_);
}

void AfeAudioProcessor::Feed(std::vector<int16_t>&& data) {
    if (afe_data_ == nullptr) {
        return;
    }

    std::lock_guard<std::mutex> lock(input_buffer_mutex_);
    // Check running state inside lock to avoid TOCTOU race with Stop()
    if (!IsRunning()) {
        return;
    }

#ifdef CONFIG_USE_SOFTWARE_AEC
    // Software AEC: interleave mic data with reference data [M, R, M, R, ...]
    std::lock_guard<std::mutex> ref_lock(reference_buffer_mutex_);

    size_t mic_samples = data.size();
    std::vector<int16_t> interleaved(mic_samples * 2);

    for (size_t i = 0; i < mic_samples; i++) {
        interleaved[i * 2] = data[i];  // Mic channel
        // Use reference data if available, otherwise use silence
        if (i < reference_buffer_.size()) {
            interleaved[i * 2 + 1] = reference_buffer_[i];
        } else {
            interleaved[i * 2 + 1] = 0;  // Silence if no reference
        }
    }

    // Remove consumed reference samples
    if (reference_buffer_.size() >= mic_samples) {
        reference_buffer_.erase(reference_buffer_.begin(), reference_buffer_.begin() + mic_samples);
    } else {
        reference_buffer_.clear();
    }

    input_buffer_.insert(input_buffer_.end(), interleaved.begin(), interleaved.end());
    // For software AEC, we have 2 channels (mic + reference)
    size_t chunk_size = afe_iface_->get_feed_chunksize(afe_data_) * 2;
#else
    input_buffer_.insert(input_buffer_.end(), data.begin(), data.end());
    size_t chunk_size = afe_iface_->get_feed_chunksize(afe_data_) * codec_->input_channels();
#endif

    while (input_buffer_.size() >= chunk_size) {
        afe_iface_->feed(afe_data_, input_buffer_.data());
        input_buffer_.erase(input_buffer_.begin(), input_buffer_.begin() + chunk_size);
    }
}

#ifdef CONFIG_USE_SOFTWARE_AEC
void AfeAudioProcessor::FeedReference(const std::vector<int16_t>& data, int sample_rate) {
    if (afe_data_ == nullptr || !IsRunning()) {
        return;
    }

    // Lock early to protect both resampler and buffer operations
    std::lock_guard<std::mutex> lock(reference_buffer_mutex_);

    std::vector<int16_t> resampled_data;

    // Resample to 16kHz if needed (AEC requires 16kHz)
    if (sample_rate != 16000) {
        // Create or update resampler if sample rate changed
        if (reference_resampler_ == nullptr || reference_sample_rate_ != sample_rate) {
            if (reference_resampler_ != nullptr) {
                esp_ae_rate_cvt_close(reference_resampler_);
                reference_resampler_ = nullptr;
            }
            esp_ae_rate_cvt_cfg_t cfg = RATE_CVT_CFG(sample_rate, 16000, 1);
            auto ret = esp_ae_rate_cvt_open(&cfg, &reference_resampler_);
            if (ret != ESP_OK || reference_resampler_ == nullptr) {
                ESP_LOGE(TAG, "Failed to create reference resampler: %d", ret);
                return;
            }
            reference_sample_rate_ = sample_rate;
            ESP_LOGI(TAG, "Created reference resampler: %d -> 16000", sample_rate);
        }

        // Calculate output size
        uint32_t in_samples = data.size();
        uint32_t out_samples = 0;
        esp_ae_rate_cvt_get_max_out_sample_num(reference_resampler_, in_samples, &out_samples);
        resampled_data.resize(out_samples);

        // Resample
        uint32_t actual_output = out_samples;
        esp_ae_rate_cvt_process(reference_resampler_,
            (esp_ae_sample_t)data.data(), in_samples,
            (esp_ae_sample_t)resampled_data.data(), &actual_output);
        resampled_data.resize(actual_output);
    } else {
        resampled_data = data;
    }

    // Add to reference buffer (already under lock)
    reference_buffer_.insert(reference_buffer_.end(), resampled_data.begin(), resampled_data.end());

    // Limit buffer size to prevent unbounded growth (keep ~200ms of data)
    const size_t max_buffer_size = 16000 / 1000 * 200;  // 200ms at 16kHz
    if (reference_buffer_.size() > max_buffer_size) {
        reference_buffer_.erase(reference_buffer_.begin(),
            reference_buffer_.begin() + (reference_buffer_.size() - max_buffer_size));
    }
}
#endif

void AfeAudioProcessor::Start() {
    xEventGroupSetBits(event_group_, PROCESSOR_RUNNING);
}

void AfeAudioProcessor::Stop() {
    xEventGroupClearBits(event_group_, PROCESSOR_RUNNING);

    std::lock_guard<std::mutex> lock(input_buffer_mutex_);
    if (afe_data_ != nullptr) {
        afe_iface_->reset_buffer(afe_data_);
    }
    input_buffer_.clear();

#ifdef CONFIG_USE_SOFTWARE_AEC
    std::lock_guard<std::mutex> ref_lock(reference_buffer_mutex_);
    reference_buffer_.clear();
    // Reset resampler to ensure clean state on next start
    if (reference_resampler_ != nullptr) {
        esp_ae_rate_cvt_close(reference_resampler_);
        reference_resampler_ = nullptr;
        reference_sample_rate_ = 0;
    }
#endif
}

bool AfeAudioProcessor::IsRunning() {
    return xEventGroupGetBits(event_group_) & PROCESSOR_RUNNING;
}

void AfeAudioProcessor::OnOutput(std::function<void(std::vector<int16_t>&& data)> callback) {
    output_callback_ = callback;
}

void AfeAudioProcessor::OnVadStateChange(std::function<void(bool speaking)> callback) {
    vad_state_change_callback_ = callback;
}

void AfeAudioProcessor::AudioProcessorTask() {
    auto fetch_size = afe_iface_->get_fetch_chunksize(afe_data_);
    auto feed_size = afe_iface_->get_feed_chunksize(afe_data_);
    ESP_LOGI(TAG, "Audio communication task started, feed size: %d fetch size: %d",
        feed_size, fetch_size);

    while (true) {
        xEventGroupWaitBits(event_group_, PROCESSOR_RUNNING, pdFALSE, pdTRUE, portMAX_DELAY);

        auto res = afe_iface_->fetch_with_delay(afe_data_, portMAX_DELAY);
        if ((xEventGroupGetBits(event_group_) & PROCESSOR_RUNNING) == 0) {
            continue;
        }
        if (res == nullptr || res->ret_value == ESP_FAIL) {
            if (res != nullptr) {
                ESP_LOGI(TAG, "Error code: %d", res->ret_value);
            }
            continue;
        }

        // VAD state change
        if (vad_state_change_callback_) {
            if (res->vad_state == VAD_SPEECH && !is_speaking_) {
                is_speaking_ = true;
                vad_state_change_callback_(true);
            } else if (res->vad_state == VAD_SILENCE && is_speaking_) {
                is_speaking_ = false;
                vad_state_change_callback_(false);
            }
        }

        if (output_callback_) {
            size_t samples = res->data_size / sizeof(int16_t);
            
            // Add data to buffer
            output_buffer_.insert(output_buffer_.end(), res->data, res->data + samples);
            
            // Output complete frames when buffer has enough data
            while (output_buffer_.size() >= frame_samples_) {
                if (output_buffer_.size() == frame_samples_) {
                    // If buffer size equals frame size, move the entire buffer
                    output_callback_(std::move(output_buffer_));
                    output_buffer_.clear();
                    output_buffer_.reserve(frame_samples_);
                } else {
                    // If buffer size exceeds frame size, copy one frame and remove it
                    output_callback_(std::vector<int16_t>(output_buffer_.begin(), output_buffer_.begin() + frame_samples_));
                    output_buffer_.erase(output_buffer_.begin(), output_buffer_.begin() + frame_samples_);
                }
            }
        }
    }
}

void AfeAudioProcessor::EnableDeviceAec(bool enable) {
    if (enable) {
#if defined(CONFIG_USE_DEVICE_AEC) || defined(CONFIG_USE_SOFTWARE_AEC)
        afe_iface_->disable_vad(afe_data_);
        afe_iface_->enable_aec(afe_data_);
        ESP_LOGI(TAG, "AEC enabled");
#else
        ESP_LOGE(TAG, "Device AEC is not supported");
#endif
    } else {
        afe_iface_->disable_aec(afe_data_);
        afe_iface_->enable_vad(afe_data_);
        ESP_LOGI(TAG, "AEC disabled, VAD enabled");
    }
}
