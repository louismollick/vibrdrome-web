import Header from './Header';
import StateMessage from './StateMessage';

interface OfflineUnavailableScreenProps {
  screenTitle: string;
  title: string;
  body: string;
}

export default function OfflineUnavailableScreen({
  screenTitle,
  title,
  body,
}: OfflineUnavailableScreenProps) {
  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <Header title={screenTitle} showBack />
      <div className="flex-1 overflow-y-auto px-4 pb-20">
        <StateMessage title={title} body={body} className="h-full" />
      </div>
    </div>
  );
}
