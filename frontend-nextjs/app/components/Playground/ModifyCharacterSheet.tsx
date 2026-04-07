import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetTrigger,
} from "@/components/ui/sheet";
import Image from "next/image";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Check, Pencil, X, Save } from "lucide-react";
import { useState } from "react";
import { Drawer, DrawerContent, DrawerTrigger } from "@/components/ui/drawer";
import { getPersonalityImageSrc } from "@/lib/utils";
import { EmojiComponent } from "./EmojiImage";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { updatePersonality } from "@/db/personalities";
import { createClient } from "@/utils/supabase/client";
import { toast } from "@/components/ui/use-toast";
import { canEditPersonality } from "@/lib/admin";

interface ModifyCharacterSheetProps {
    openPersonality: IPersonality;
    isCurrentPersonality: boolean;
    children: React.ReactNode;
    onPersonalityPicked: (personalityIdPicked: string) => void;
    languageState: string;
    disableButtons: boolean;
    currentUser?: IUser;
    onPersonalityUpdated?: (updated: IPersonality) => void;
}

const ModifyCharacterSheet: React.FC<ModifyCharacterSheetProps> = ({
    openPersonality,
    isCurrentPersonality,
    children,
    onPersonalityPicked,
    languageState,
    disableButtons,
    currentUser,
    onPersonalityUpdated,
}) => {
    const [isSent, setIsSent] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editForm, setEditForm] = useState({
        title: openPersonality.title,
        short_description: openPersonality.short_description,
        character_prompt: openPersonality.character_prompt,
        first_message_prompt: openPersonality.first_message_prompt,
        voice_prompt: openPersonality.voice_prompt,
    });

    const supabase = createClient();
    const isDesktop = useMediaQuery("(min-width: 768px)");

    const isPersonalCharacter = openPersonality.creator_id !== null;
    const isDoctor = openPersonality.is_doctor;

    const canEdit = currentUser && canEditPersonality(
        currentUser.email,
        currentUser.user_id,
        openPersonality
    );

    const handleSave = async () => {
        if (!openPersonality.personality_id) return;

        setIsSaving(true);
        try {
            const updated = await updatePersonality(
                supabase,
                openPersonality.personality_id,
                editForm
            );
            if (updated) {
                toast({
                    title: "Saved",
                    description: "Character updated successfully",
                });
                setIsEditMode(false);
                onPersonalityUpdated?.(updated);
            }
        } catch (error) {
            toast({
                title: "Error",
                description: "Failed to update character",
                variant: "destructive",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancelEdit = () => {
        setEditForm({
            title: openPersonality.title,
            short_description: openPersonality.short_description,
            character_prompt: openPersonality.character_prompt,
            first_message_prompt: openPersonality.first_message_prompt,
            voice_prompt: openPersonality.voice_prompt,
        });
        setIsEditMode(false);
    };

    const ButtonsComponent = () => {
        if (isEditMode) {
            return (
                <div className="flex flex-row gap-2 p-4">
                    <Button
                        size="lg"
                        variant="outline"
                        className="flex-1 rounded-full"
                        onClick={handleCancelEdit}
                        disabled={isSaving}
                    >
                        <X className="h-5 w-5 mr-2" />
                        Cancel
                    </Button>
                    <Button
                        size="lg"
                        className="flex-1 rounded-full bg-green-500 hover:bg-green-600"
                        onClick={handleSave}
                        disabled={isSaving}
                    >
                        <Save className="h-5 w-5 mr-2" />
                        {isSaving ? "Saving..." : "Save"}
                    </Button>
                </div>
            );
        }

        return (
            <div className="flex flex-row gap-2 p-4">
                {canEdit && (
                    <Button
                        size="lg"
                        variant="outline"
                        className="rounded-full"
                        onClick={() => setIsEditMode(true)}
                    >
                        <Pencil className="h-5 w-5" />
                    </Button>
                )}
                <Button
                    size="lg"
                    className={`flex-1 rounded-full text-sm md:text-lg flex flex-row items-center gap-1 md:gap-2 transition-colors duration-300 ${
                        isSent || isCurrentPersonality
                            ? "bg-green-500 hover:bg-green-600"
                            : ""
                    }`}
                    variant={disableButtons ? "upsell_primary" : "default"}
                    disabled={isCurrentPersonality || disableButtons}
                    onClick={() => {
                        setIsSent(true);
                        onPersonalityPicked(openPersonality.personality_id!);
                        setTimeout(() => setIsSent(false), 10000);
                    }}
                >
                    <Check className="flex-shrink-0 h-5 w-5 md:h-6 md:w-6" />
                    {isSent || isCurrentPersonality
                        ? "Live character"
                        : "Click to chat"}
                </Button>
            </div>
        );
    };

    const PersonalCharacterComponent = () => {
        return (
            <>
            <p className="text-gray-400">
                        {"Character prompt"}
                    </p>
                    <p className="text-gray-600 whitespace-pre-line">
                            {openPersonality.character_prompt}
                        </p>
                        <p className="text-gray-400">
                        {"First message prompt"}
                    </p>
                    <p className="text-gray-600">
                            {openPersonality.first_message_prompt}
                        </p>
                     <p className="text-gray-400">
                        {"Voice prompt"}
                    </p>
                    <p className="text-gray-600">
                            {openPersonality.voice_prompt}
                        </p>
            </>
        );
    };

    const editFormContent = (
        <div className="container mx-auto p-4 max-w-4xl space-y-4">
            <h3 className="text-xl font-semibold">Edit Character</h3>

            <div className="space-y-2">
                <Label htmlFor="edit-title">Title</Label>
                <Input
                    id="edit-title"
                    value={editForm.title}
                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                />
                <p className="text-sm text-right text-gray-500">{editForm.title?.length || 0}/50</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <Textarea
                    id="edit-description"
                    rows={3}
                    value={editForm.short_description}
                    onChange={(e) => setEditForm({ ...editForm, short_description: e.target.value })}
                />
                <p className="text-sm text-right text-gray-500">{editForm.short_description?.length || 0}/200</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="edit-character-prompt">Character Prompt</Label>
                <Textarea
                    id="edit-character-prompt"
                    rows={8}
                    value={editForm.character_prompt}
                    onChange={(e) => setEditForm({ ...editForm, character_prompt: e.target.value })}
                />
                <p className="text-sm text-right text-gray-500">{editForm.character_prompt?.length || 0}/5000</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="edit-first-message">First Message Prompt</Label>
                <Textarea
                    id="edit-first-message"
                    rows={3}
                    value={editForm.first_message_prompt}
                    onChange={(e) => setEditForm({ ...editForm, first_message_prompt: e.target.value })}
                />
                <p className="text-sm text-right text-gray-500">{editForm.first_message_prompt?.length || 0}/150</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="edit-voice-prompt">Voice Prompt</Label>
                <Textarea
                    id="edit-voice-prompt"
                    rows={3}
                    value={editForm.voice_prompt}
                    onChange={(e) => setEditForm({ ...editForm, voice_prompt: e.target.value })}
                />
                <p className="text-sm text-right text-gray-500">{editForm.voice_prompt?.length || 0}/200</p>
            </div>
        </div>
    );

    const viewContent = (
        <div className="container mx-auto p-4 max-w-4xl">
            <div className="flex flex-col items-center gap-6">
                {isPersonalCharacter ? (
                    <div className="relative w-full h-[100px] sm:h-[200px] flex items-center justify-center">
                    <EmojiComponent personality={openPersonality} size={100} />
                    </div>
                ) : (
                    <div className="relative w-full h-[300px] sm:h-[400px]">
                        <Image
                            src={getPersonalityImageSrc(openPersonality.key)}
                            alt={openPersonality.title}
                            className="rounded-lg object-top sm:object-center object-cover"
                            fill
                        />
                    </div>
                )}
                <div className="space-y-2 text-left w-full relative">
                <div className="absolute top-0 right-0">
                <Badge variant="outline">
                    {openPersonality.provider}
                </Badge>
            </div>
                <div className="flex flex-row items-center gap-2">
                    <h3 className="text-xl font-semibold">
                        {openPersonality.title}
                    </h3>
                </div>

                <p className="text-gray-400">
                    {openPersonality.subtitle}
                </p>
                <p className="text-gray-600">
                    {openPersonality.short_description}
                </p>
                {(isPersonalCharacter || isDoctor) && (
                    <PersonalCharacterComponent />
                )}
            </div>
            </div>
        </div>
    );

    const contentElement = isEditMode ? editFormContent : viewContent;

    if (isDesktop) {
        return (
            <Sheet>
                <SheetTrigger asChild>{children}</SheetTrigger>
                <SheetContent
                    className="rounded-tl-xl gap-0 rounded-bl-xl overflow-y-auto p-0"
                    style={{ maxWidth: "500px" }}
                    side="right"
                >
                    <div className="min-h-[100dvh] flex flex-col">
                        <div className="flex-1">
                            {contentElement}
                        </div>
                        <div className="sticky bottom-0 w-full bg-background border-t">
                            <ButtonsComponent />
                        </div>
                    </div>
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <Drawer>
            <DrawerTrigger asChild>{children}</DrawerTrigger>
            <DrawerContent className="h-[70vh]">
                <div className="flex flex-col h-full overflow-y-auto">
                    <div className="flex-shrink-0">
                        <ButtonsComponent />
                    </div>
                    <div className="flex-1 overflow-y-auto">
                        {contentElement}
                    </div>
                </div>
            </DrawerContent>
        </Drawer>
    );
};

export default ModifyCharacterSheet;
