import Block from "components/services/widget/block";
import Container from "components/services/widget/container";

import useWidgetAPI from "utils/proxy/use-widget-api";

export default function Component({ service }) {
  const { widget } = service;
  const { data, error } = useWidgetAPI(widget, "status");

  if (error) {
    return <Container service={service} error={error} />;
  }

  if (!data) {
    return (
      <Container service={service}>
        <Block label="cyberpower.status" />
        <Block label="cyberpower.load" />
        <Block label="cyberpower.capacity" />
        <Block label="cyberpower.runtime" />
      </Container>
    );
  }

  return (
    <Container service={service}>
      <Block label="cyberpower.status" value={data.battery.status} />
      <Block label="cyberpower.load" value={data.output.load} />
      <Block label="cyberpower.capacity" value={data.battery.capacity} />
      <Block label="cyberpower.runtime" value={data.battery.runtime} />
    </Container>
  );
}
