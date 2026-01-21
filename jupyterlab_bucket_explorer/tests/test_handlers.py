import json


async def test_health(jp_fetch):
    response = await jp_fetch("jupyterlab-bucket-explorer", "health")

    assert response.code == 200
    payload = json.loads(response.body)
    assert payload == {"status": "ok"}
