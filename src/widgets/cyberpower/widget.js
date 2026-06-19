import cyberpowerProxyHandler from "./proxy";

const widget = {
  api: "{url}/api/{endpoint}",
  proxyHandler: cyberpowerProxyHandler,

  mappings: {
    status: {
      endpoint: "upsstatus/",
    },
  }
};

export default widget;
