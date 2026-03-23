#ifndef DISPLAY_HANDLER_H
#define DISPLAY_HANDLER_H

#include <Arduino.h>

void displayInit();
void displayTask(void *parameter);
void displaySetChatMessage(const char *role, const char *text);
void displaySetRegistrationInfo(const char *url, const char *userCode);

#endif
