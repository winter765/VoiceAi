#ifndef LCD_DISPLAY_H
#define LCD_DISPLAY_H

#include "lvgl_display.h"
#include "gif/lvgl_gif.h"

#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_ops.h>
#include <font_emoji.h>

#include <atomic>
#include <memory>
#include <string>

#define PREVIEW_IMAGE_DURATION_MS 5000


class LcdDisplay : public LvglDisplay {
protected:
    esp_lcd_panel_io_handle_t panel_io_ = nullptr;
    esp_lcd_panel_handle_t panel_ = nullptr;
    
    lv_draw_buf_t draw_buf_;
    lv_obj_t* top_bar_ = nullptr;
    lv_obj_t* status_bar_ = nullptr;
    lv_obj_t* content_ = nullptr;
    lv_obj_t* container_ = nullptr;
    lv_obj_t* side_bar_ = nullptr;
    lv_obj_t* bottom_bar_ = nullptr;
    lv_obj_t* preview_image_ = nullptr;
    lv_obj_t* emoji_label_ = nullptr;
    lv_obj_t* emoji_image_ = nullptr;
    std::unique_ptr<LvglGif> gif_controller_ = nullptr;
    lv_obj_t* emoji_box_ = nullptr;
    lv_obj_t* chat_message_label_ = nullptr;
    lv_obj_t* chat_content_area_ = nullptr;  // Full-screen chat display area
    lv_obj_t* chat_hint_label_ = nullptr;    // Centered hint when no chat
    esp_timer_handle_t preview_timer_ = nullptr;
    esp_timer_handle_t chat_page_timer_ = nullptr;  // Timer for auto page turn

    // Chef AI: Recipe and Timer display areas
    lv_obj_t* recipe_bar_ = nullptr;         // Recipe progress bar
    lv_obj_t* recipe_name_label_ = nullptr;  // Recipe name label
    lv_obj_t* recipe_step_label_ = nullptr;  // Recipe step label (e.g., "2/5")
    lv_obj_t* timer_bar_ = nullptr;          // Timer display area (container)
    static constexpr int MAX_DISPLAY_TIMERS = 3;  // Max timers to display per page
    lv_obj_t* timer_rows_[MAX_DISPLAY_TIMERS] = {nullptr};  // Timer row containers
    lv_obj_t* timer_name_labels_[MAX_DISPLAY_TIMERS] = {nullptr};
    lv_obj_t* timer_time_labels_[MAX_DISPLAY_TIMERS] = {nullptr};
    esp_timer_handle_t timer_update_timer_ = nullptr;  // Timer for updating countdown display
    esp_timer_handle_t timer_page_timer_ = nullptr;    // Timer for auto page turn
    int timer_current_page_ = 0;                       // Current timer page index
    static constexpr int TIMER_PAGE_INTERVAL_MS = 10000;  // 10 seconds per page

    // Recipe session state
    std::string current_recipe_name_;
    int current_recipe_step_ = 0;
    int total_recipe_steps_ = 0;
    std::unique_ptr<LvglImage> preview_image_cached_ = nullptr;
    bool hide_subtitle_ = false;  // Control whether to hide chat messages/subtitles

    // Chat pagination
    std::string chat_full_text_;  // Full chat message
    int chat_current_page_ = 0;   // Current page index
    int chat_total_pages_ = 0;    // Total pages
    int chat_lines_per_page_ = 15; // Lines per page
    static constexpr int CHAT_PAGE_INTERVAL_MS = 3000;  // Auto page turn interval

    void InitializeLcdThemes();
    virtual bool Lock(int timeout_ms = 0) override;
    virtual void Unlock() override;

protected:
    // Add protected constructor
    LcdDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel, int width, int height);
    
public:
    ~LcdDisplay();
    virtual void SetEmotion(const char* emotion) override;
    virtual void SetChatMessage(const char* role, const char* content) override;
    virtual void ClearChatMessages() override;
    virtual void SetPreviewImage(std::unique_ptr<LvglImage> image) override;
    virtual void SetupUI() override;
    // Add theme switching function
    virtual void SetTheme(Theme* theme) override;
    
    // Set whether to hide chat messages/subtitles
    void SetHideSubtitle(bool hide);

    // Chat pagination
    void NextChatPage();
    void ShowChatPage(int page);

    // Chef AI: Recipe and Timer display
    void SetRecipeInfo(const char* recipe_name, int current_step, int total_steps);
    void ClearRecipeInfo();
    void UpdateTimerDisplay();  // Called periodically to refresh timer countdown
    void NextTimerPage();       // Auto page turn for timers (when > 3 timers)
    void RecalculateChatAreaHeight();  // Adjust chat area based on visible bars
};

// SPI LCD display
class SpiLcdDisplay : public LcdDisplay {
public:
    SpiLcdDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                  int width, int height, int offset_x, int offset_y,
                  bool mirror_x, bool mirror_y, bool swap_xy);
};

// RGB LCD display
class RgbLcdDisplay : public LcdDisplay {
public:
    RgbLcdDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                  int width, int height, int offset_x, int offset_y,
                  bool mirror_x, bool mirror_y, bool swap_xy);
};

// MIPI LCD display
class MipiLcdDisplay : public LcdDisplay {
public:
    MipiLcdDisplay(esp_lcd_panel_io_handle_t panel_io, esp_lcd_panel_handle_t panel,
                   int width, int height, int offset_x, int offset_y,
                   bool mirror_x, bool mirror_y, bool swap_xy);
};

#endif // LCD_DISPLAY_H
