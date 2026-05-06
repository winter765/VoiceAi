#ifndef _MOUTH_CONTROL_H_
#define _MOUTH_CONTROL_H_

#include <driver/gpio.h>
#include "device_state.h"

class MouthControl {
public:
    MouthControl(gpio_num_t gpio);
    ~MouthControl();

    void OnStateChanged(DeviceState old_state, DeviceState new_state);
    void SetEnabled(bool enabled);
    bool IsEnabled() const { return enabled_; }

private:
    gpio_num_t gpio_;
    bool enabled_ = true;
    int listener_id_ = -1;

    void SetMouthOpen(bool open);
};

#endif // _MOUTH_CONTROL_H_
