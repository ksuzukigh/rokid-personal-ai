<script def>
{ "navigationBarTitleText": "私のAI" }
</script>

<script setup>
export default {
  data: {
    state: '準備中…'
  }
}
</script>

<page>
  <view class="screen">
    <text class="title">私のAI</text>
    <text class="state">{{ state }}</text>
  </view>
</page>

<style>
.screen { display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; height:100vh; padding:14px 18px; background-color:#000000; }
.title,.state { width:100%; color:#40ff5e; text-align:center; }
.title { font-size:24px; line-height:29px; margin-bottom:10px; }
.state { font-size:18px; line-height:23px; margin-bottom:10px; }
</style>
