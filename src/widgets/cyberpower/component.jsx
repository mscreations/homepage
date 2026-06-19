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
        <Block label="Status" />
        <Block label="Load %" />
        <Block label="Capacity %" />
        <Block label="Runtime Min" />
      </Container>
    );
  }

  return (
    <Container service={service}>
      <Block label="Status" value={data.battery.status} />
      <Block label="Load %" value={data.output.load} />
      <Block label="Capacity %" value={data.battery.capacity} />
      <Block label="Runtime Min" value={data.battery.runtime} />
    </Container>
  );
}
