package controllers;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import auth.AuthUtils;
import com.typesafe.config.ConfigFactory;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import play.libs.Json;
import play.mvc.Http;

public class AiServiceControllerTest {
  private static final String ACTOR = "urn:li:corpuser:user1";
  private static final String SECRET = "test-proxy-secret-test-proxy-secret";

  private AiServiceController controller(HttpClient client) {
    return new AiServiceController(
        client,
        ConfigFactory.parseMap(
            Map.of(
                "aiService.endpoint", "http://ai-service:8091", "aiService.proxySecret", SECRET)));
  }

  private Http.RequestBuilder authenticated(String method, String uri) {
    return new Http.RequestBuilder()
        .method(method)
        .uri(uri)
        .session(Map.of(AuthUtils.ACTOR, ACTOR, AuthUtils.ACCESS_TOKEN, "test-token"))
        .cookie(Http.Cookie.builder(AuthUtils.ACTOR, ACTOR).build());
  }

  @Test
  public void requiresSessionForHistoryAndDeletion() throws Exception {
    HttpClient client = mock(HttpClient.class);
    Http.Request unauthenticated =
        new Http.RequestBuilder().method("DELETE").uri("/ai-service/v1/conversations").build();
    assertEquals(
        401, controller(client).forward("v1/conversations", unauthenticated).get().status());
    verifyNoInteractions(client);
  }

  @Test
  public void rejectsPathsOutsideTheAssistantApi() throws Exception {
    HttpClient client = mock(HttpClient.class);
    assertEquals(
        404,
        controller(client)
            .forward("../api/graphql", authenticated("GET", "/ai-service/../api/graphql").build())
            .get()
            .status());
    verifyNoInteractions(client);
  }

  @Test
  @SuppressWarnings("unchecked")
  public void forwardsSessionIdentityAndOriginalMethodForRenameAndDelete() throws Exception {
    HttpClient client = mock(HttpClient.class);
    HttpResponse<byte[]> upstream = mock(HttpResponse.class);
    when(upstream.statusCode()).thenReturn(200);
    when(upstream.body()).thenReturn("{}".getBytes());
    doReturn(CompletableFuture.completedFuture(upstream)).when(client).sendAsync(any(), any());
    String id = "11111111-1111-4111-8111-111111111111";
    Http.Request rename =
        authenticated("PATCH", "/ai-service/v1/conversations/" + id)
            .header("X-DataHub-AI-Actor", "urn:li:corpuser:user2")
            .bodyJson(Json.newObject().put("title", "My analysis"))
            .build();
    assertEquals(200, controller(client).forward("v1/conversations/" + id, rename).get().status());
    Http.Request delete = authenticated("DELETE", "/ai-service/v1/conversations").build();
    assertEquals(200, controller(client).forward("v1/conversations", delete).get().status());
    ArgumentCaptor<HttpRequest> captor = ArgumentCaptor.forClass(HttpRequest.class);
    verify(client, times(2)).sendAsync(captor.capture(), any());
    HttpRequest forwarded = captor.getAllValues().get(0);
    assertEquals("PATCH", forwarded.method());
    assertEquals(ACTOR, forwarded.headers().firstValue("X-DataHub-AI-Actor").orElseThrow());
    assertEquals(
        "Bearer test-token", forwarded.headers().firstValue("Authorization").orElseThrow());
    assertEquals("DELETE", captor.getAllValues().get(1).method());
    assertNotEquals(
        forwarded.headers().firstValue("X-DataHub-AI-Signature"),
        captor.getAllValues().get(1).headers().firstValue("X-DataHub-AI-Signature"));
  }
}
