import CharacterSection from "./CharacterSection";

interface UserPersonalitiesProps {
    onPersonalityPicked: (personalityIdPicked: string) => void;
    allPersonalities: IPersonality[];
    personalityIdState: string;
    languageState: string;
    disableButtons: boolean;
    selectedFilters: PersonalityFilter[];
    myPersonalities: IPersonality[];
    currentUser?: IUser;
    onPersonalityUpdated?: (updated: IPersonality) => void;
}

const UserPersonalities: React.FC<UserPersonalitiesProps> = ({
    onPersonalityPicked,
    allPersonalities,
    personalityIdState,
    languageState,
    disableButtons,
    selectedFilters,
    myPersonalities,
    currentUser,
    onPersonalityUpdated,
}) => {
    return (
        <div className="flex flex-col gap-8 w-full">
            {myPersonalities.length > 0 && (
                <CharacterSection
                    selectedFilters={selectedFilters}
                    allPersonalities={myPersonalities}
                    languageState={languageState}
                    personalityIdState={personalityIdState}
                    onPersonalityPicked={onPersonalityPicked}
                    title={"My Characters"}
                    disableButtons={disableButtons}
                    currentUser={currentUser}
                    onPersonalityUpdated={onPersonalityUpdated}
                />
            )}
        <CharacterSection
            allPersonalities={allPersonalities}
            languageState={languageState}
            personalityIdState={personalityIdState}
            onPersonalityPicked={onPersonalityPicked}
            title={"Characters"}
            disableButtons={disableButtons}
            selectedFilters={selectedFilters}
            currentUser={currentUser}
            onPersonalityUpdated={onPersonalityUpdated}
        />
        </div>

    );
};

export default UserPersonalities;
